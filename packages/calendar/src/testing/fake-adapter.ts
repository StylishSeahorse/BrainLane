/**
 * An in-memory calendar provider.
 *
 * This exists so the sync engine can be developed and tested against something
 * that behaves like a real provider — including the parts that are painful:
 * ETag preconditions, cursor expiry, pagination, and tombstones.
 *
 * Its capabilities are configurable, which is the point. Setting
 * `{ push: false, etags: false, incrementalSync: false }` produces something
 * that behaves like a plain CalDAV server, so the engine's handling of a
 * weak provider is testable long before the CalDAV adapter is written.
 */
import type { CalendarAdapter } from '../adapter';
import {
  AuthenticationError,
  NotFoundError,
  PreconditionFailedError,
  ReadOnlyCalendarError,
  SyncCursorInvalidError,
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
  type Subscription,
} from '../types';

interface StoredEvent extends RemoteEvent {
  /** Monotonic version, the basis of both ETags and cursors. */
  revision: number;
}

export interface FakeAdapterOptions {
  provider?: ProviderKind;
  capabilities?: Partial<AdapterCapabilities>;
  calendars?: RemoteCalendar[];
  /** Force the next pull to reject the cursor, as Google does with 410 GONE. */
  invalidateCursorOnNextPull?: boolean;
  /** Reject every call with an auth error. */
  credentialsInvalid?: boolean;
}

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  push: true,
  incrementalSync: true,
  etags: true,
  recurrenceEditScopes: ['instance', 'thisAndFuture', 'series'],
  deletionTombstones: true,
  maxPageSize: 100,
};

export class FakeCalendarAdapter implements CalendarAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: AdapterCapabilities;

  /** calendarExternalId -> externalId -> event */
  private readonly store = new Map<string, Map<string, StoredEvent>>();
  private readonly calendars: RemoteCalendar[];
  private readonly subscriptions = new Map<string, Subscription>();

  private revisionCounter = 0;
  private invalidateNextCursor: boolean;
  private credentialsInvalid: boolean;

  /** Call log, so tests can assert on retry and idempotency behaviour. */
  readonly calls: Array<{ method: string; detail?: string }> = [];

  constructor(options: FakeAdapterOptions = {}) {
    this.provider = options.provider ?? 'GOOGLE';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.calendars = options.calendars ?? [
      {
        externalId: 'primary',
        name: 'Primary',
        timeZone: 'UTC',
        canWrite: true,
        isPrimary: true,
      },
    ];
    this.invalidateNextCursor = options.invalidateCursorOnNextPull ?? false;
    this.credentialsInvalid = options.credentialsInvalid ?? false;

    for (const calendar of this.calendars) {
      this.store.set(calendar.externalId, new Map());
    }
  }

  // --- Test controls -------------------------------------------------------

  /** Simulate a change made directly at the provider, e.g. in Google's own UI. */
  seedRemoteEvent(calendarExternalId: string, event: Partial<RemoteEvent> & { externalId: string }): RemoteEvent {
    const events = this.requireCalendar(calendarExternalId);
    this.revisionCounter += 1;

    const stored: StoredEvent = {
      iCalUid: `${event.externalId}@fake`,
      title: 'Untitled',
      startsAt: new Date('2026-06-15T09:00:00Z'),
      endsAt: new Date('2026-06-15T10:00:00Z'),
      isAllDay: false,
      timeZone: 'UTC',
      status: 'CONFIRMED',
      transparency: 'BUSY',
      isDeleted: false,
      ...event,
      etag: `etag-${this.revisionCounter}`,
      remoteUpdatedAt: new Date(),
      revision: this.revisionCounter,
    };

    events.set(stored.externalId, stored);
    return this.toRemote(stored);
  }

  /** Delete at the provider, producing a real tombstone. */
  deleteRemoteEvent(calendarExternalId: string, externalId: string): void {
    const events = this.requireCalendar(calendarExternalId);
    const existing = events.get(externalId);
    if (!existing) return;

    this.revisionCounter += 1;
    events.set(externalId, {
      ...existing,
      isDeleted: true,
      status: 'CANCELLED',
      revision: this.revisionCounter,
      etag: `etag-${this.revisionCounter}`,
    });
  }

  expireCursor(): void {
    this.invalidateNextCursor = true;
  }

  invalidateCredentials(): void {
    this.credentialsInvalid = true;
  }

  countEvents(calendarExternalId: string): number {
    return [...this.requireCalendar(calendarExternalId).values()].filter((e) => !e.isDeleted).length;
  }

  // --- Adapter -------------------------------------------------------------

  async listCalendars(_connection: ConnectionRef): Promise<RemoteCalendar[]> {
    this.assertCredentials();
    this.calls.push({ method: 'listCalendars' });
    return [...this.calendars];
  }

  async pull(
    _connection: ConnectionRef,
    calendar: CalendarRef,
    cursor: string | undefined,
  ): Promise<PullResult> {
    this.assertCredentials();
    this.calls.push({ method: 'pull', detail: cursor });

    if (this.invalidateNextCursor && cursor) {
      this.invalidateNextCursor = false;
      throw new SyncCursorInvalidError();
    }

    const events = [...this.requireCalendar(calendar.externalId).values()];
    const since = cursor ? Number(cursor) : 0;
    const isFullSnapshot = !cursor || !this.capabilities.incrementalSync;

    const relevant = isFullSnapshot
      ? // A full snapshot lists what currently exists. Deleted events are simply
        // absent — which is exactly why absence must never imply deletion.
        events.filter((event) => !event.isDeleted)
      : events.filter((event) => event.revision > since);

    const ordered = relevant.sort((a, b) => a.revision - b.revision);
    const page = ordered.slice(0, this.capabilities.maxPageSize);
    const hasMore = ordered.length > page.length;

    const highest = page.reduce((max, event) => Math.max(max, event.revision), since);

    return {
      changes: page.map((event) => this.toRemote(event)),
      nextCursor: this.capabilities.incrementalSync ? String(highest) : undefined,
      fullResyncRequired: false,
      isFullSnapshot,
      hasMore,
    };
  }

  async createEvent(
    _connection: ConnectionRef,
    calendar: CalendarRef,
    draft: EventDraft,
  ): Promise<RemoteEvent> {
    this.assertCredentials();
    this.assertWritable(calendar.externalId);
    this.calls.push({ method: 'createEvent', detail: draft.iCalUid });

    const events = this.requireCalendar(calendar.externalId);

    // Idempotency: a retry after a lost response finds the UID already present
    // and adopts it rather than creating a duplicate.
    for (const existing of events.values()) {
      if (existing.iCalUid === draft.iCalUid && !existing.isDeleted) {
        return this.toRemote(existing);
      }
    }

    this.revisionCounter += 1;
    const stored: StoredEvent = {
      externalId: `evt-${this.revisionCounter}`,
      iCalUid: draft.iCalUid,
      title: draft.title,
      description: draft.description,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      isAllDay: false,
      timeZone: draft.timeZone,
      status: 'CONFIRMED',
      transparency: draft.transparency,
      isDeleted: false,
      etag: `etag-${this.revisionCounter}`,
      remoteUpdatedAt: new Date(),
      revision: this.revisionCounter,
    };

    events.set(stored.externalId, stored);
    return this.toRemote(stored);
  }

  async updateEvent(
    _connection: ConnectionRef,
    calendar: CalendarRef,
    ref: EventRef,
    patch: EventPatch,
  ): Promise<RemoteEvent> {
    this.assertCredentials();
    this.assertWritable(calendar.externalId);
    this.calls.push({ method: 'updateEvent', detail: ref.externalId });

    const events = this.requireCalendar(calendar.externalId);
    const existing = events.get(ref.externalId);
    if (!existing || existing.isDeleted) throw new NotFoundError(ref.externalId);

    // The precondition that prevents silent overwrites.
    if (this.capabilities.etags && ref.etag && ref.etag !== existing.etag) {
      throw new PreconditionFailedError(ref.externalId);
    }

    this.revisionCounter += 1;
    const updated: StoredEvent = {
      ...existing,
      ...patch,
      etag: `etag-${this.revisionCounter}`,
      remoteUpdatedAt: new Date(),
      revision: this.revisionCounter,
    };

    events.set(ref.externalId, updated);
    return this.toRemote(updated);
  }

  async deleteEvent(
    _connection: ConnectionRef,
    calendar: CalendarRef,
    ref: EventRef,
  ): Promise<void> {
    this.assertCredentials();
    this.assertWritable(calendar.externalId);
    this.calls.push({ method: 'deleteEvent', detail: ref.externalId });

    const events = this.requireCalendar(calendar.externalId);
    const existing = events.get(ref.externalId);
    if (!existing || existing.isDeleted) throw new NotFoundError(ref.externalId);

    if (this.capabilities.etags && ref.etag && ref.etag !== existing.etag) {
      throw new PreconditionFailedError(ref.externalId);
    }

    this.deleteRemoteEvent(calendar.externalId, ref.externalId);
  }

  async watch(
    _connection: ConnectionRef,
    calendar: CalendarRef,
    _callbackUrl: string,
  ): Promise<Subscription> {
    this.assertCredentials();
    if (!this.capabilities.push) throw new Error('This provider does not support push');

    const subscription: Subscription = {
      channelId: `channel-${calendar.externalId}-${this.subscriptions.size + 1}`,
      resourceId: `resource-${calendar.externalId}`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      token: `token-${Math.random().toString(36).slice(2)}`,
    };

    this.subscriptions.set(subscription.channelId, subscription);
    return subscription;
  }

  async unwatch(_connection: ConnectionRef, subscription: Subscription): Promise<void> {
    this.subscriptions.delete(subscription.channelId);
  }

  async verifyConnection(_connection: ConnectionRef): Promise<boolean> {
    return !this.credentialsInvalid;
  }

  // --- Internals -----------------------------------------------------------

  private assertCredentials(): void {
    if (this.credentialsInvalid) throw new AuthenticationError();
  }

  private assertWritable(calendarExternalId: string): void {
    const calendar = this.calendars.find((c) => c.externalId === calendarExternalId);
    if (calendar && !calendar.canWrite) throw new ReadOnlyCalendarError();
  }

  private requireCalendar(externalId: string): Map<string, StoredEvent> {
    const events = this.store.get(externalId);
    if (!events) throw new Error(`Unknown calendar "${externalId}" in fake adapter`);
    return events;
  }

  private toRemote(stored: StoredEvent): RemoteEvent {
    const { revision: _revision, ...event } = stored;
    return { ...event };
  }
}
