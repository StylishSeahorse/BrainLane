/**
 * CalDAV (RFC 4791) — the open-standard calendar provider.
 *
 * Worth knowing before reading this: CalDAV is WebDAV, so a calendar is a
 * collection of resources and an event is a text file in it. There is no
 * "events API"; there is `PROPFIND`, `REPORT`, `PUT` and `DELETE`, and every
 * payload is iCalendar text.
 *
 * Three properties of the protocol shaped this implementation:
 *
 *   1. NO PUSH. Nothing tells us a calendar changed, so `capabilities.push` is
 *      false and the sync engine polls. That flag existing is the reason the
 *      engine needed no CalDAV-shaped branch anywhere.
 *
 *   2. DELETIONS ARE EXPLICIT — but only in a sync report. A `sync-collection`
 *      REPORT returns removed resources with a 404 status, which is a real
 *      tombstone. A `calendar-query`, by contrast, simply omits them, and it is
 *      also time-bounded. So a full snapshot from here reports the window it
 *      covers and never implies anything about what is missing.
 *
 *   3. ETAGS ARE THE WHOLE CONCURRENCY STORY. Every write carries `If-Match`
 *      and a 412 means someone else got there first. This is what stops a
 *      background sync overwriting an edit made in another client thirty
 *      seconds earlier.
 */
import { assertScopeSupported, type CalendarAdapter } from '../../adapter';
import { parseCalendarObject, serializeAppBlock, patchCalendarObject } from '../../icalendar';
import {
  AuthenticationError,
  CalendarError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitError,
  ReadOnlyCalendarError,
  type AdapterCapabilities,
  type CalendarRef,
  type ConnectionRef,
  type EventDraft,
  type EventPatch,
  type EventRef,
  type ProviderKind,
  type PullResult,
  type RemoteCalendar,
  type RemoteEvent,
} from '../../types';
import { basicAuth, createTransport, type CalDavResponse, type CalDavTransport } from './http';
import {
  asArray,
  escapeXml,
  parseMultiStatus,
  prop,
  propChildNames,
  propHasChild,
  propText,
  statusCode,
  type DavResponse,
} from './xml';

export interface CalDavAdapterOptions {
  /** Injected in tests; defaults to the SSRF-guarded transport. */
  transport?: CalDavTransport;
  allowLocalhost?: boolean;
  /** How far back a full snapshot reaches. */
  snapshotPastDays?: number;
  snapshotFutureDays?: number;
  /** Resources fetched per `calendar-multiget`. */
  batchSize?: number;
  now?: () => Date;
}

const DAV_NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

export class CalDavAdapter implements CalendarAdapter {
  readonly provider: ProviderKind = 'CALDAV';

  readonly capabilities: AdapterCapabilities = {
    // No server-initiated notifications in base CalDAV. The engine polls.
    push: false,
    // RFC 6578 sync-collection. Servers that lack it fail the first sync report
    // and fall back to snapshots, which `pull` handles.
    incrementalSync: true,
    etags: true,
    // Editing a single occurrence means writing a RECURRENCE-ID override into
    // the same resource as the master — a rewrite of someone else's series
    // object. We decline instead: an unsupported scope is refused, never
    // approximated.
    recurrenceEditScopes: ['series'],
    deletionTombstones: true,
    maxPageSize: 100,
  };

  private readonly transport: CalDavTransport;
  private readonly snapshotPastDays: number;
  private readonly snapshotFutureDays: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(options: CalDavAdapterOptions = {}) {
    this.transport =
      options.transport ??
      createTransport({ ...(options.allowLocalhost ? { allowLocalhost: true } : {}) });
    this.snapshotPastDays = options.snapshotPastDays ?? 90;
    this.snapshotFutureDays = options.snapshotFutureDays ?? 400;
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  private credentials(connection: ConnectionRef): {
    serverUrl: string;
    username: string;
    password: string;
  } {
    const { serverUrl, username, password } = connection.credentials;
    if (!serverUrl || !username || password === undefined) {
      // Not retryable, and phrased as an auth problem on purpose: the fix is
      // for the user to reconnect, not for the worker to try again.
      throw new AuthenticationError('This CalDAV connection has no server address or sign-in.');
    }
    return { serverUrl, username, password };
  }

  private async request(
    connection: ConnectionRef,
    url: URL,
    method: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<CalDavResponse> {
    const { username, password } = this.credentials(connection);

    return this.transport({
      method,
      url,
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        authorization: basicAuth(username, password),
        ...init.headers,
      },
    });
  }

  /**
   * Map an HTTP status onto the typed errors the sync engine reacts to.
   *
   * The distinction that matters most is retryable versus not. An adapter that
   * reports a revoked password as a generic failure makes the worker retry
   * forever against a connection that will never work again.
   */
  private raise(response: CalDavResponse, context: string): never {
    const { status } = response;

    if (status === 401 || status === 403) {
      // 403 on a write is a permission problem with the calendar, not the
      // credentials — the difference decides whether we tell the user to
      // reconnect or to pick a different calendar.
      if (status === 403 && /write|create|update|delete/i.test(context)) {
        throw new ReadOnlyCalendarError('The server refused the write: this calendar is read-only.');
      }
      throw new AuthenticationError('The CalDAV server rejected these credentials.');
    }

    if (status === 404) throw new NotFoundError(response.url.toString());
    if (status === 412) throw new PreconditionFailedError(response.url.toString());

    if (status === 429 || status === 503) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      throw new RateLimitError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
    }

    // 5xx is worth retrying; a 4xx we did not recognize is a request we got
    // wrong, and repeating it will not help.
    throw new CalendarError(`CalDAV ${context} failed with HTTP ${status}.`, status >= 500);
  }

  private ok(response: CalDavResponse, context: string, accept: number[]): CalDavResponse {
    if (!accept.includes(response.status)) this.raise(response, context);
    return response;
  }

  private resolve(href: string, base: URL): URL {
    return new URL(href, base);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Find the user's calendar home.
   *
   * People paste whatever their provider's help page showed them: an origin, a
   * principal path, or the collection itself. The standard route is
   * origin → `/.well-known/caldav` → principal → calendar-home-set, and each
   * step is skipped when the URL already got us there.
   */
  async discoverHome(connection: ConnectionRef): Promise<URL> {
    const { serverUrl } = this.credentials(connection);
    const start = new URL(serverUrl);

    const candidates = [start];
    if (!start.pathname.includes('/.well-known/')) {
      candidates.push(new URL('/.well-known/caldav', start.origin));
    }

    let principal: URL | undefined;

    for (const candidate of candidates) {
      const response = await this.request(connection, candidate, 'PROPFIND', {
        headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
        body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${DAV_NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
      });

      if (response.status === 401) {
        throw new AuthenticationError('The CalDAV server rejected these credentials.');
      }
      if (response.status !== 207) continue;

      const href = firstHref(parseMultiStatus(response.body).responses, 'current-user-principal');
      if (href) {
        principal = this.resolve(href, response.url);
        break;
      }
    }

    if (!principal) {
      // Some servers hand out a URL that is already the home collection and
      // expose no principal. Trying it directly beats refusing to connect.
      return start;
    }

    const response = await this.request(connection, principal, 'PROPFIND', {
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${DAV_NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
    });
    this.ok(response, 'calendar-home-set lookup', [207]);

    const home = firstHref(parseMultiStatus(response.body).responses, 'calendar-home-set');
    return home ? this.resolve(home, response.url) : start;
  }

  async listCalendars(connection: ConnectionRef): Promise<RemoteCalendar[]> {
    const home = await this.discoverHome(connection);

    const response = await this.request(connection, home, 'PROPFIND', {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${DAV_NS}>
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <c:supported-calendar-component-set/>
    <c:calendar-timezone/>
  </d:prop>
</d:propfind>`,
    });
    this.ok(response, 'calendar listing', [207]);

    const calendars: RemoteCalendar[] = [];

    for (const entry of parseMultiStatus(response.body).responses) {
      if (!propHasChild(entry, 'resourcetype', 'calendar')) continue;
      if (!supportsEvents(entry)) continue;

      const url = this.resolve(entry.href, response.url);
      // Trailing slash matters: without it, resolving `abc.ics` against the
      // collection would replace the last path segment instead of appending.
      if (!url.pathname.endsWith('/')) url.pathname += '/';

      const privileges = propChildNames(entry, 'current-user-privilege-set');

      calendars.push({
        externalId: url.toString(),
        name: propText(entry, 'displayname') || 'Calendar',
        timeZone: calendarTimeZone(entry) ?? 'UTC',
        // A server that does not report privileges is assumed writable; the
        // 403 on the first write maps to a clear read-only error, which beats
        // hiding a usable calendar from someone.
        canWrite:
          privileges.length === 0 ||
          privileges.includes('write') ||
          privileges.includes('write-content'),
        // CalDAV has no notion of a primary calendar, so the first one is a
        // default rather than a claim.
        isPrimary: calendars.length === 0,
      });
    }

    return calendars;
  }

  async verifyConnection(connection: ConnectionRef): Promise<boolean> {
    try {
      await this.discoverHome(connection);
      return true;
    } catch (error) {
      if (error instanceof AuthenticationError) return false;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async pull(
    connection: ConnectionRef,
    calendar: CalendarRef,
    cursor: string | undefined,
  ): Promise<PullResult> {
    const collection = new URL(calendar.externalId);
    return cursor
      ? this.pullIncremental(connection, calendar, collection, cursor)
      : this.pullSnapshot(connection, calendar, collection);
  }

  private async pullSnapshot(
    connection: ConnectionRef,
    calendar: CalendarRef,
    collection: URL,
  ): Promise<PullResult> {
    // The token is taken BEFORE the query, deliberately. Anything changed
    // between the two shows up again in the next incremental pull; taking it
    // afterwards would place those changes before the cursor and lose them
    // permanently. Duplicated work is recoverable, skipped changes are not.
    const nextCursor = await this.fetchSyncToken(connection, collection);

    const now = this.now();
    const from = new Date(now.getTime() - this.snapshotPastDays * 86_400_000);
    const to = new Date(now.getTime() + this.snapshotFutureDays * 86_400_000);

    const response = await this.request(connection, collection, 'REPORT', {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${DAV_NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${icsStamp(from)}" end="${icsStamp(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    });
    this.ok(response, 'calendar query', [207]);

    const changes = this.eventsFrom(parseMultiStatus(response.body).responses, response.url, calendar);

    return {
      changes,
      ...(nextCursor ? { nextCursor } : {}),
      fullResyncRequired: false,
      isFullSnapshot: true,
      hasMore: false,
      // Bounded, and the engine must know it. Everything outside this range is
      // simply unexamined — not missing.
      snapshotWindow: { from, to },
    };
  }

  private async pullIncremental(
    connection: ConnectionRef,
    calendar: CalendarRef,
    collection: URL,
    cursor: string,
  ): Promise<PullResult> {
    const response = await this.request(connection, collection, 'REPORT', {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection ${DAV_NS}>
  <d:sync-token>${escapeXml(cursor)}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`,
    });

    // A rejected token is normal — servers expire them — and it is not an
    // error. It means "start again from a snapshot", which the engine does
    // under the deletion circuit breaker.
    const parsed = parseMultiStatus(response.body);
    if (
      response.status === 403 ||
      response.status === 409 ||
      parsed.errors.includes('valid-sync-token')
    ) {
      return { changes: [], fullResyncRequired: true, isFullSnapshot: false, hasMore: false };
    }

    // Servers that never implemented RFC 6578 answer a sync report with 400 or
    // 501. Same recovery: fall back to a snapshot.
    if (response.status === 400 || response.status === 501) {
      return { changes: [], fullResyncRequired: true, isFullSnapshot: false, hasMore: false };
    }

    this.ok(response, 'sync report', [207]);

    const changedHrefs: string[] = [];
    const tombstones: RemoteEvent[] = [];

    for (const entry of parsed.responses) {
      const url = this.resolve(entry.href, response.url).toString();
      const code = statusCode(entry.status);

      if (code === 404 || code === 410) {
        // An explicit removal signal from the server — the only thing that may
        // ever set isDeleted.
        tombstones.push(tombstone(url, calendar.timeZone));
        continue;
      }

      // The collection itself appears in the report; it is not an event.
      if (url === collection.toString()) continue;
      changedHrefs.push(url);
    }

    const changes: RemoteEvent[] = [];
    for (let index = 0; index < changedHrefs.length; index += this.batchSize) {
      const batch = changedHrefs.slice(index, index + this.batchSize);
      changes.push(...(await this.multiget(connection, calendar, collection, batch)));
    }

    return {
      changes: [...changes, ...tombstones],
      ...(parsed.syncToken ? { nextCursor: parsed.syncToken } : {}),
      fullResyncRequired: false,
      isFullSnapshot: false,
      hasMore: false,
    };
  }

  private async fetchSyncToken(
    connection: ConnectionRef,
    collection: URL,
  ): Promise<string | undefined> {
    const response = await this.request(connection, collection, 'PROPFIND', {
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind ${DAV_NS}><d:prop><d:sync-token/></d:prop></d:propfind>`,
    });

    // Not fatal. A server without sync tokens just means every pull is a
    // snapshot, which is slower but equally safe.
    if (response.status !== 207) return undefined;

    for (const entry of parseMultiStatus(response.body).responses) {
      const token = propText(entry, 'sync-token');
      if (token) return token;
    }
    return undefined;
  }

  private async multiget(
    connection: ConnectionRef,
    calendar: CalendarRef,
    collection: URL,
    hrefs: string[],
  ): Promise<RemoteEvent[]> {
    if (hrefs.length === 0) return [];

    const response = await this.request(connection, collection, 'REPORT', {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget ${DAV_NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  ${hrefs.map((href) => `<d:href>${escapeXml(new URL(href).pathname)}</d:href>`).join('\n  ')}
</c:calendar-multiget>`,
    });
    this.ok(response, 'multiget', [207]);

    return this.eventsFrom(parseMultiStatus(response.body).responses, response.url, calendar);
  }

  private eventsFrom(
    responses: DavResponse[],
    base: URL,
    calendar: CalendarRef,
  ): RemoteEvent[] {
    const events: RemoteEvent[] = [];

    for (const entry of responses) {
      const data = propText(entry, 'calendar-data');
      if (!data) continue;

      const etag = propText(entry, 'getetag');
      const href = this.resolve(entry.href, base).toString();

      events.push(
        ...parseCalendarObject(data, {
          href,
          ...(etag ? { etag } : {}),
          defaultTimeZone: calendar.timeZone,
        }),
      );
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async createEvent(
    connection: ConnectionRef,
    calendar: CalendarRef,
    draft: EventDraft,
  ): Promise<RemoteEvent> {
    const collection = new URL(calendar.externalId);
    const href = new URL(`${encodeURIComponent(draft.iCalUid)}.ics`, collection);

    const response = await this.request(connection, href, 'PUT', {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        // "Only if it does not already exist." This is what makes a retried
        // create safe: the second attempt is refused rather than duplicated.
        'if-none-match': '*',
      },
      body: serializeAppBlock(draft, this.now()),
    });

    if (response.status === 412 || response.status === 409) {
      // Already there — the outbox is retrying a write that actually
      // succeeded. Adopt the existing event instead of creating a second one.
      const existing = await this.findExisting(connection, calendar, collection, href, draft.iCalUid);
      if (existing) return existing;
    }

    if (response.status !== 201 && response.status !== 204 && response.status !== 200) {
      this.raise(response, 'create');
    }

    const etag = response.headers.get('etag');
    return {
      externalId: href.toString(),
      iCalUid: draft.iCalUid,
      ...(etag ? { etag } : {}),
      title: draft.title,
      ...(draft.description ? { description: draft.description } : {}),
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      isAllDay: false,
      timeZone: draft.timeZone,
      status: 'CONFIRMED',
      transparency: draft.transparency,
      isDeleted: false,
    };
  }

  /** Locate an event we may already have written — by path, then by UID. */
  private async findExisting(
    connection: ConnectionRef,
    calendar: CalendarRef,
    collection: URL,
    href: URL,
    iCalUid: string,
  ): Promise<RemoteEvent | undefined> {
    const direct = await this.request(connection, href, 'GET');
    if (direct.status === 200) {
      const etag = direct.headers.get('etag');
      const [event] = parseCalendarObject(direct.body, {
        href: href.toString(),
        ...(etag ? { etag } : {}),
        defaultTimeZone: calendar.timeZone,
      });
      if (event) return event;
    }

    // Another client may have stored the same UID under a different filename,
    // which is legal. A UID query is the only way to find it.
    const response = await this.request(connection, collection, 'REPORT', {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query ${DAV_NS}>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:prop-filter name="UID">
          <c:text-match collation="i;octet">${escapeXml(iCalUid)}</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    });

    if (response.status !== 207) return undefined;
    return this.eventsFrom(parseMultiStatus(response.body).responses, response.url, calendar)[0];
  }

  async updateEvent(
    connection: ConnectionRef,
    calendar: CalendarRef,
    ref: EventRef,
    patch: EventPatch,
  ): Promise<RemoteEvent> {
    const href = this.eventUrl(ref.externalId);

    const current = await this.request(connection, href, 'GET');
    if (current.status === 404) throw new NotFoundError(ref.externalId);
    this.ok(current, 'update', [200]);

    const [existing] = parseCalendarObject(current.body, {
      href: href.toString(),
      defaultTimeZone: calendar.timeZone,
    });
    if (!existing) throw new NotFoundError(ref.externalId);

    // Refuses rather than guesses when the scope is not one we can express.
    assertScopeSupported(this, existing, ref.scope);

    // The ETag the caller held, not the one we just read. Using the fresh one
    // would make every write succeed and quietly destroy the concurrent edit
    // this precondition exists to catch.
    const expected = ref.etag ?? current.headers.get('etag') ?? undefined;

    const response = await this.request(connection, href, 'PUT', {
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        ...(expected ? { 'if-match': expected } : {}),
      },
      body: patchCalendarObject(current.body, patch),
    });

    if (response.status === 412) throw new PreconditionFailedError(ref.externalId);
    if (response.status === 404) throw new NotFoundError(ref.externalId);
    if (![200, 201, 204].includes(response.status)) this.raise(response, 'update');

    const etag = response.headers.get('etag');
    return {
      ...existing,
      ...(etag ? { etag } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.startsAt ? { startsAt: patch.startsAt } : {}),
      ...(patch.endsAt ? { endsAt: patch.endsAt } : {}),
      ...(patch.transparency ? { transparency: patch.transparency } : {}),
    };
  }

  async deleteEvent(
    connection: ConnectionRef,
    _calendar: CalendarRef,
    ref: EventRef,
  ): Promise<void> {
    const href = this.eventUrl(ref.externalId);

    const response = await this.request(connection, href, 'DELETE', {
      headers: ref.etag ? { 'if-match': ref.etag } : {},
    });

    if (response.status === 412) throw new PreconditionFailedError(ref.externalId);
    if (response.status === 404) throw new NotFoundError(ref.externalId);
    if (![200, 202, 204].includes(response.status)) this.raise(response, 'delete');
  }

  /**
   * The resource URL for an event id.
   *
   * A modified occurrence carries a `#recurrence-id` suffix and lives inside
   * its master's resource. Writing to it would mean rewriting the whole series
   * object, so it is refused here — the same decision as declaring only the
   * `series` edit scope, enforced at the other end.
   */
  private eventUrl(externalId: string): URL {
    if (externalId.includes('#')) {
      throw new ReadOnlyCalendarError(
        'This is a single changed occurrence of a repeating event. ' +
          'Editing one occurrence over CalDAV would rewrite the whole series, so it is left alone.',
      );
    }

    try {
      return new URL(externalId);
    } catch {
      throw new NotFoundError(externalId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstHref(responses: DavResponse[], property: string): string | undefined {
  for (const response of responses) {
    const value = prop(response, property);
    if (typeof value === 'object' && value !== null) {
      const href = (value as Record<string, unknown>)['href'];
      const first = Array.isArray(href) ? href[0] : href;
      if (typeof first === 'string' && first) return first;
    }
  }
  return undefined;
}

/**
 * Does this collection hold events?
 *
 * A CalDAV home often contains task lists (VTODO) and subscribed address
 * books. Showing someone their task list as a calendar to schedule into is a
 * confusing failure, so collections that do not advertise VEVENT are skipped.
 * A collection that advertises nothing is included — the property is optional.
 */
function supportsEvents(response: DavResponse): boolean {
  const value = prop(response, 'supported-calendar-component-set');
  if (typeof value !== 'object' || value === null) return true;

  const comps = asArray((value as Record<string, unknown>)['comp']);
  if (comps.length === 0) return true;

  return comps.some(
    (comp) =>
      typeof comp === 'object' &&
      comp !== null &&
      (comp as Record<string, unknown>)['@name'] === 'VEVENT',
  );
}

/** The TZID out of a collection's default VTIMEZONE. */
function calendarTimeZone(response: DavResponse): string | undefined {
  const value = propText(response, 'calendar-timezone');
  if (!value) return undefined;

  const match = /^TZID:(.+)$/m.exec(value.replace(/\r\n/g, '\n'));
  return match?.[1]?.trim();
}

function tombstone(externalId: string, timeZone: string): RemoteEvent {
  const epoch = new Date(0);
  return {
    externalId,
    title: '',
    startsAt: epoch,
    endsAt: epoch,
    isAllDay: false,
    timeZone,
    status: 'CANCELLED',
    transparency: 'FREE',
    isDeleted: true,
  };
}

function icsStamp(instant: Date): string {
  return `${instant.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}
