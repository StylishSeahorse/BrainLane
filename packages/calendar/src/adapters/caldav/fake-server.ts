/**
 * An in-memory CalDAV server, for testing the adapter.
 *
 * Not a mock of our own calls — a small implementation of the protocol. It
 * speaks real `multistatus` XML, stores real iCalendar text, enforces
 * `If-Match` and `If-None-Match`, and keeps a change log so `sync-collection`
 * returns genuine deltas and genuine 404 tombstones.
 *
 * That distinction matters. A mock that returns whatever the adapter asked for
 * proves only that the adapter can call itself. This catches the things that
 * actually break against a real server: XML that does not parse, an ETag that
 * round-trips wrong, a tombstone read as a change.
 */
import { basicAuth, type CalDavRequest, type CalDavResponse, type CalDavTransport } from './http';

export const ORIGIN = 'https://caldav.test';
export const PRINCIPAL = '/principals/alice/';
export const HOME = '/calendars/alice/';
export const CALENDAR = '/calendars/alice/work/';
export const TASK_LIST = '/calendars/alice/todos/';

interface Resource {
  ics: string;
  etag: string;
}

interface Change {
  token: number;
  path: string;
  deleted: boolean;
}

export interface FakeCalDavOptions {
  username?: string;
  password?: string;
  /** Answer sync reports with a rejected-token error, as an expired server would. */
  rejectSyncToken?: boolean;
  /** Answer sync reports with 501, as a server predating RFC 6578 would. */
  noSyncSupport?: boolean;
}

export class FakeCalDavServer {
  private readonly resources = new Map<string, Resource>();
  private readonly changes: Change[] = [];
  private token = 0;
  private etagCounter = 0;

  readonly requests: CalDavRequest[] = [];

  constructor(private readonly options: FakeCalDavOptions = {}) {}

  private get username(): string {
    return this.options.username ?? 'alice';
  }

  private get password(): string {
    return this.options.password ?? 'secret';
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Put an event on the server as though another client had created it. */
  seed(name: string, ics: string): string {
    const path = `${CALENDAR}${name}.ics`;
    this.write(path, ics);
    return `${ORIGIN}${path}`;
  }

  remove(url: string): void {
    const path = new URL(url).pathname;
    if (!this.resources.delete(path)) return;
    this.token += 1;
    this.changes.push({ token: this.token, path, deleted: true });
  }

  has(url: string): boolean {
    return this.resources.has(new URL(url).pathname);
  }

  body(url: string): string | undefined {
    return this.resources.get(new URL(url).pathname)?.ics;
  }

  private write(path: string, ics: string): string {
    this.etagCounter += 1;
    const etag = `"etag-${this.etagCounter}"`;
    this.resources.set(path, { ics, etag });
    this.token += 1;
    this.changes.push({ token: this.token, path, deleted: false });
    return etag;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  get transport(): CalDavTransport {
    return async (request) => {
      this.requests.push(request);
      return this.handle(request);
    };
  }

  private reply(
    request: CalDavRequest,
    status: number,
    body = '',
    headers: Record<string, string> = {},
  ): CalDavResponse {
    return {
      status,
      body,
      url: request.url,
      headers: new Headers({ 'content-type': 'application/xml; charset=utf-8', ...headers }),
    };
  }

  private handle(request: CalDavRequest): CalDavResponse {
    const expected = basicAuth(this.username, this.password);
    if (request.headers?.['authorization'] !== expected) {
      return this.reply(request, 401);
    }

    const path = request.url.pathname;
    const depth = request.headers?.['depth'] ?? '0';

    switch (request.method) {
      case 'PROPFIND':
        return this.propfind(request, path, depth);
      case 'REPORT':
        return this.report(request, path);
      case 'GET':
        return this.get(request, path);
      case 'PUT':
        return this.put(request, path);
      case 'DELETE':
        return this.del(request, path);
      default:
        return this.reply(request, 405);
    }
  }

  private propfind(request: CalDavRequest, path: string, depth: string): CalDavResponse {
    const body = request.body ?? '';

    if (body.includes('current-user-principal')) {
      return this.reply(
        request,
        207,
        multistatus([
          responseXml(path, [
            [`<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`],
          ]),
        ]),
      );
    }

    if (body.includes('calendar-home-set')) {
      return this.reply(
        request,
        207,
        multistatus([
          responseXml(path, [
            [`<cal:calendar-home-set><d:href>${HOME}</d:href></cal:calendar-home-set>`],
          ]),
        ]),
      );
    }

    if (body.includes('sync-token')) {
      return this.reply(
        request,
        207,
        multistatus([responseXml(path, [[`<d:sync-token>${this.syncToken()}</d:sync-token>`]])]),
      );
    }

    if (path === HOME && depth === '1') {
      return this.reply(
        request,
        207,
        multistatus([
          // The home collection lists itself first, and it is not a calendar.
          responseXml(HOME, [['<d:resourcetype><d:collection/></d:resourcetype>']]),
          responseXml(CALENDAR, [
            [
              '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>',
              '<d:displayname>Work</d:displayname>',
              '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>',
              '<d:current-user-privilege-set>' +
                '<d:privilege><d:read/></d:privilege>' +
                '<d:privilege><d:write-content/></d:privilege>' +
                '</d:current-user-privilege-set>',
              `<cal:calendar-timezone>${escape(
                'BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/London\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n',
              )}</cal:calendar-timezone>`,
            ],
          ]),
          // A task list. Advertises no VEVENT support, so it must not be
          // offered as somewhere to schedule work.
          responseXml(TASK_LIST, [
            [
              '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>',
              '<d:displayname>Reminders</d:displayname>',
              '<cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>',
            ],
          ]),
        ]),
      );
    }

    return this.reply(request, 207, multistatus([]));
  }

  private syncToken(): string {
    return `${ORIGIN}/sync/${this.token}`;
  }

  private report(request: CalDavRequest, path: string): CalDavResponse {
    const body = request.body ?? '';

    if (body.includes('sync-collection')) return this.syncReport(request, body);
    if (body.includes('calendar-multiget')) return this.multiget(request, body);
    if (body.includes('calendar-query')) return this.query(request, body, path);

    return this.reply(request, 400);
  }

  private syncReport(request: CalDavRequest, body: string): CalDavResponse {
    if (this.options.noSyncSupport) return this.reply(request, 501);

    if (this.options.rejectSyncToken) {
      return this.reply(
        request,
        403,
        `<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`,
      );
    }

    const since = Number(/<d:sync-token>[^<]*\/sync\/(\d+)<\/d:sync-token>/.exec(body)?.[1] ?? '0');

    // Latest state per path wins: an event created and then edited since the
    // cursor is one change, not two.
    const latest = new Map<string, Change>();
    for (const change of this.changes) {
      if (change.token > since) latest.set(change.path, change);
    }

    const entries = [...latest.values()].map((change) =>
      change.deleted
        ? `<d:response><d:href>${change.path}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
        : responseXml(change.path, [
            [`<d:getetag>${escape(this.resources.get(change.path)?.etag ?? '')}</d:getetag>`],
          ]),
    );

    return this.reply(
      request,
      207,
      multistatus(entries, `<d:sync-token>${this.syncToken()}</d:sync-token>`),
    );
  }

  private multiget(request: CalDavRequest, body: string): CalDavResponse {
    const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((match) => match[1]!);
    return this.reply(request, 207, multistatus(hrefs.map((href) => this.dataFor(href))));
  }

  private query(request: CalDavRequest, body: string, path: string): CalDavResponse {
    if (!path.endsWith('/')) return this.reply(request, 404);

    const uidFilter = /<c(?:al)?:text-match[^>]*>([^<]+)<\/c(?:al)?:text-match>/.exec(body)?.[1];

    const paths = [...this.resources.keys()].filter((candidate) => {
      if (!candidate.startsWith(path)) return false;
      if (!uidFilter) return true;
      return this.resources.get(candidate)?.ics.includes(`UID:${unescape_(uidFilter)}`) ?? false;
    });

    return this.reply(request, 207, multistatus(paths.map((candidate) => this.dataFor(candidate))));
  }

  private dataFor(path: string): string {
    const resource = this.resources.get(path);
    if (!resource) {
      return `<d:response><d:href>${path}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
    }
    return responseXml(path, [
      [
        `<d:getetag>${escape(resource.etag)}</d:getetag>`,
        `<cal:calendar-data>${escape(resource.ics)}</cal:calendar-data>`,
      ],
    ]);
  }

  private get(request: CalDavRequest, path: string): CalDavResponse {
    const resource = this.resources.get(path);
    if (!resource) return this.reply(request, 404);
    return this.reply(request, 200, resource.ics, {
      'content-type': 'text/calendar; charset=utf-8',
      etag: resource.etag,
    });
  }

  private put(request: CalDavRequest, path: string): CalDavResponse {
    const existing = this.resources.get(path);
    const ifMatch = request.headers?.['if-match'];
    const ifNoneMatch = request.headers?.['if-none-match'];

    if (ifNoneMatch === '*' && existing) return this.reply(request, 412);
    if (ifMatch && (!existing || existing.etag !== ifMatch)) return this.reply(request, 412);

    // RFC 4791 allows only one object per UID per collection, and real servers
    // enforce it. Without this the fake would happily store a duplicate that a
    // Nextcloud or Radicale would have refused.
    const uid = /^UID:(.+)$/m.exec((request.body ?? '').replace(/\r\n/g, '\n'))?.[1]?.trim();
    if (uid && !existing) {
      const collection = path.slice(0, path.lastIndexOf('/') + 1);
      for (const [other, resource] of this.resources) {
        if (!other.startsWith(collection) || other === path) continue;
        if (new RegExp(`^UID:${escapeRegExp(uid)}$`, 'm').test(resource.ics.replace(/\r\n/g, '\n'))) {
          return this.reply(
            request,
            409,
            `<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:no-uid-conflict/></d:error>`,
          );
        }
      }
    }

    const etag = this.write(path, request.body ?? '');
    return this.reply(request, existing ? 204 : 201, '', { etag });
  }

  private del(request: CalDavRequest, path: string): CalDavResponse {
    const existing = this.resources.get(path);
    if (!existing) return this.reply(request, 404);

    const ifMatch = request.headers?.['if-match'];
    if (ifMatch && existing.etag !== ifMatch) return this.reply(request, 412);

    this.remove(`${ORIGIN}${path}`);
    return this.reply(request, 204);
  }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unescape_(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function responseXml(href: string, propGroups: string[][]): string {
  const propstats = propGroups
    .map(
      (props) =>
        `<d:propstat><d:prop>${props.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`,
    )
    .join('');
  return `<d:response><d:href>${href}</d:href>${propstats}</d:response>`;
}

function multistatus(entries: string[], extra = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
${entries.join('\n')}
${extra}
</d:multistatus>`;
}

/** Build an iCalendar object the way another client would have written one. */
export function icsFixture(options: {
  uid: string;
  summary?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  rrule?: string;
  extraLines?: string[];
}): string {
  const {
    uid,
    summary = 'Standup',
    start = '20260615T090000Z',
    end = '20260615T093000Z',
    timeZone,
    rrule,
    extraLines = [],
  } = options;

  const dtstart = timeZone ? `DTSTART;TZID=${timeZone}:${start}` : `DTSTART:${start}`;
  const dtend = timeZone ? `DTEND;TZID=${timeZone}:${end}` : `DTEND:${end}`;

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Some Other Client//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260601T120000Z',
    dtstart,
    dtend,
    `SUMMARY:${summary}`,
    ...(rrule ? [rrule] : []),
    ...extraLines,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
