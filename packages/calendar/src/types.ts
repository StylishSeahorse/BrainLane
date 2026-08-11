/**
 * The normalized calendar vocabulary.
 *
 * Every provider is translated into these types at the adapter boundary, so the
 * sync engine never learns that Google exists. That is not architectural
 * tidiness for its own sake — it is what stops provider quirks leaking into the
 * logic that decides whether to delete a user's event.
 */

/** Which provider an adapter speaks to. */
export type ProviderKind = 'GOOGLE' | 'MICROSOFT' | 'CALDAV';

/**
 * What a provider can actually do.
 *
 * This is the load-bearing piece of the abstraction. The sync engine branches
 * on capabilities, never on provider identity — so adding CalDAV (no push, no
 * ETags on some servers, limited recurrence editing) requires no `if (provider
 * === 'CALDAV')` anywhere in the engine. Every one of these flags exists
 * because some real provider differs on it.
 */
export interface AdapterCapabilities {
  /** Server-initiated change notifications. CalDAV servers generally lack this. */
  push: boolean;
  /** Cursor-based delta sync. Without it, we reconcile against a full snapshot. */
  incrementalSync: boolean;
  /** Per-event version markers usable as a write precondition. */
  etags: boolean;
  /** Which recurrence edit scopes may be written. Empty means series are read-only. */
  recurrenceEditScopes: RecurrenceEditScope[];
  /** Provider issues explicit deletion tombstones rather than mere absence. */
  deletionTombstones: boolean;
  /** Largest page the provider will return, for pagination sizing. */
  maxPageSize: number;
}

export type RecurrenceEditScope = 'instance' | 'thisAndFuture' | 'series';

export interface ProviderCredentials {
  /** Decrypted at the last possible moment, by the worker, never by the web app. */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  /** CalDAV: server URL plus basic/digest credentials. */
  serverUrl?: string;
  username?: string;
  password?: string;
}

export interface ConnectionRef {
  id: string;
  userId: string;
  provider: ProviderKind;
  credentials: ProviderCredentials;
}

export interface RemoteCalendar {
  externalId: string;
  name: string;
  timeZone: string;
  color?: string;
  canWrite: boolean;
  /** The provider's primary calendar, a sensible default write target. */
  isPrimary: boolean;
}

export interface CalendarRef {
  id: string;
  externalId: string;
  timeZone: string;
}

export type RemoteEventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
export type RemoteTransparency = 'BUSY' | 'FREE';

/** A calendar event, normalized. */
export interface RemoteEvent {
  externalId: string;
  iCalUid?: string;
  etag?: string;
  sequence?: number;

  title: string;
  description?: string;
  location?: string;

  startsAt: Date;
  endsAt: Date;
  isAllDay: boolean;
  /** IANA id the event was authored in. Needed to survive DST. */
  timeZone: string;

  /**
   * RFC 5545 recurrence lines, exactly as the provider gave them.
   *
   * Verbatim is a hard rule. Parsing and re-emitting an RRULE we did not author
   * is how a weekly meeting quietly becomes a daily one, or shifts an hour at a
   * DST boundary. We only ever write rules we generated ourselves.
   */
  rrule?: string;
  recurringEventId?: string;
  originalStartsAt?: Date;

  status: RemoteEventStatus;
  transparency: RemoteTransparency;
  remoteUpdatedAt?: Date;

  /**
   * The provider explicitly told us this event is gone.
   *
   * Set only from a real deletion signal. Absence from a listing is not
   * deletion — treating it as such is how a full resync becomes mass data loss.
   */
  isDeleted: boolean;
}

/** An event we want to write. */
export interface EventDraft {
  /** Deterministic for app-created blocks; the basis of idempotent creates. */
  iCalUid: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  transparency: RemoteTransparency;
}

export interface EventPatch {
  title?: string;
  description?: string;
  startsAt?: Date;
  endsAt?: Date;
  transparency?: RemoteTransparency;
}

/** Identifies an event to update or delete, with its expected version. */
export interface EventRef {
  externalId: string;
  /** Sent as an If-Match precondition where the provider supports it. */
  etag?: string;
  /** Required when editing a recurring event. */
  scope?: RecurrenceEditScope;
}

export interface PullResult {
  changes: RemoteEvent[];
  /** Cursor for the next incremental pull. Persist only with the batch. */
  nextCursor?: string;
  /**
   * The cursor was rejected (Google 410 GONE, Graph resync required). The next
   * pull must reconcile against a full snapshot — under the deletion circuit
   * breaker, never by trusting absence.
   */
  fullResyncRequired: boolean;
  /**
   * True when `changes` is a complete snapshot of the calendar rather than a
   * delta. Only a complete snapshot may drive absence-based reconciliation, and
   * even then only with the circuit breaker armed.
   */
  isFullSnapshot: boolean;
  /** More pages remain; call again with this cursor. */
  hasMore: boolean;
  /**
   * The time range a full snapshot actually covers.
   *
   * Load-bearing for CalDAV. A `calendar-query` is always bounded — asking a
   * shared work calendar for every event since 1970 is a request that times
   * out — so its result is a complete snapshot *of a window*, not of the
   * collection. Without this field the sync engine would see every event
   * outside the window as absent and tombstone the lot.
   *
   * Absent means the snapshot really does cover everything.
   */
  snapshotWindow?: { from: Date; to: Date };
}

export interface Subscription {
  channelId: string;
  resourceId: string;
  expiresAt: Date;
  /** Raw token handed to the provider; only its digest is persisted. */
  token: string;
}

// ---------------------------------------------------------------------------
// Errors
//
// Typed so the sync engine can react correctly. An adapter that reports a
// permission failure as a generic error causes the engine to retry forever
// against a connection that will never work.
// ---------------------------------------------------------------------------

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Credentials expired or were revoked. Not retryable; needs the user. */
export class AuthenticationError extends CalendarError {
  constructor(message = 'Calendar credentials are no longer valid') {
    super(message, false);
  }
}

/** The sync cursor is no longer usable. Triggers a guarded full resync. */
export class SyncCursorInvalidError extends CalendarError {
  constructor(message = 'Sync cursor has expired') {
    super(message, true);
  }
}

/**
 * The remote copy changed since the ETag we held.
 *
 * This is the one that prevents silent overwrites. It means "someone else
 * edited this first" — the engine must re-read and reconcile, never retry the
 * same write blindly.
 */
export class PreconditionFailedError extends CalendarError {
  constructor(
    readonly externalId: string,
    message = 'Event was modified remotely since it was last read',
  ) {
    super(message, false);
  }
}

export class RateLimitError extends CalendarError {
  constructor(readonly retryAfterMs: number) {
    super(`Rate limited; retry in ${retryAfterMs}ms`, true);
  }
}

export class NotFoundError extends CalendarError {
  constructor(readonly externalId: string) {
    super(`Event ${externalId} does not exist at the provider`, false);
  }
}

/** The provider refused a write we are not permitted to make. */
export class ReadOnlyCalendarError extends CalendarError {
  constructor(message = 'This calendar is read-only') {
    super(message, false);
  }
}
