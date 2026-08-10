/**
 * The calendar provider interface.
 *
 * Written before any provider exists, deliberately. An abstraction retrofitted
 * around a first implementation ends up shaped like that implementation, and
 * the second provider then has to be forced through a Google-shaped hole. The
 * awkward parts of CalDAV — no push, weak ETags, restricted recurrence editing
 * — are what `capabilities` exists to express.
 *
 * Contract every implementation must honour:
 *
 *   1. NEVER report an event as deleted unless the provider said so explicitly.
 *      Absence from a listing means "not on this page", never "deleted".
 *   2. Preserve `rrule` verbatim. Do not parse and re-emit it.
 *   3. Surface a version conflict as `PreconditionFailedError`, never by
 *      overwriting.
 *   4. Map provider errors onto the typed errors in `./types.js` so the sync
 *      engine can distinguish "retry" from "stop and ask the user".
 *   5. `pull` must be resumable and idempotent: the same cursor twice yields
 *      the same changes, and applying them twice is harmless.
 */
import type {
  AdapterCapabilities,
  CalendarRef,
  ConnectionRef,
  EventDraft,
  EventPatch,
  EventRef,
  ProviderKind,
  PullResult,
  RemoteCalendar,
  RemoteEvent,
  Subscription,
} from './types';

export interface CalendarAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: AdapterCapabilities;

  /** Calendars visible to this connection. */
  listCalendars(connection: ConnectionRef): Promise<RemoteCalendar[]>;

  /**
   * Fetch changes since `cursor`.
   *
   * With no cursor, or when the provider has invalidated it, returns a full
   * snapshot with `isFullSnapshot: true`. The caller must not infer deletions
   * from anything else.
   */
  pull(
    connection: ConnectionRef,
    calendar: CalendarRef,
    cursor: string | undefined,
  ): Promise<PullResult>;

  /**
   * Create an event.
   *
   * Must be idempotent on `draft.iCalUid`: if an event with that UID already
   * exists, return the existing event rather than creating a duplicate. This is
   * what makes an at-least-once outbox safe, and duplicate events are the
   * fastest way to lose a user's trust in a sync product.
   */
  createEvent(
    connection: ConnectionRef,
    calendar: CalendarRef,
    draft: EventDraft,
  ): Promise<RemoteEvent>;

  /**
   * Update an event.
   *
   * When `ref.etag` is present and the provider supports ETags, it must be sent
   * as a precondition, and a mismatch must raise `PreconditionFailedError`.
   * A recurring event requires `ref.scope`; a scope outside
   * `capabilities.recurrenceEditScopes` must be refused, not approximated.
   */
  updateEvent(
    connection: ConnectionRef,
    calendar: CalendarRef,
    ref: EventRef,
    patch: EventPatch,
  ): Promise<RemoteEvent>;

  /** Delete an event, with the same precondition and scope rules as update. */
  deleteEvent(connection: ConnectionRef, calendar: CalendarRef, ref: EventRef): Promise<void>;

  /**
   * Subscribe to push notifications. Only defined when `capabilities.push`.
   *
   * The notification itself is treated purely as a "something changed" signal:
   * we re-fetch over the authenticated API rather than trusting any payload.
   * That is what makes a spoofed webhook harmless.
   */
  watch?(
    connection: ConnectionRef,
    calendar: CalendarRef,
    callbackUrl: string,
  ): Promise<Subscription>;

  unwatch?(connection: ConnectionRef, subscription: Subscription): Promise<void>;

  /** Cheap credential check, for the settings screen. */
  verifyConnection(connection: ConnectionRef): Promise<boolean>;
}

/** Adapters that genuinely support push, narrowed for the caller. */
export interface PushCapableAdapter extends CalendarAdapter {
  watch(
    connection: ConnectionRef,
    calendar: CalendarRef,
    callbackUrl: string,
  ): Promise<Subscription>;
  unwatch(connection: ConnectionRef, subscription: Subscription): Promise<void>;
}

export function supportsPush(adapter: CalendarAdapter): adapter is PushCapableAdapter {
  return adapter.capabilities.push && typeof adapter.watch === 'function';
}

/**
 * Refuse a recurrence edit the provider cannot express.
 *
 * Approximating an unsupported scope is how "change this one occurrence"
 * silently rewrites an entire series. Failing loudly is the correct behaviour.
 */
export function assertScopeSupported(
  adapter: CalendarAdapter,
  event: Pick<RemoteEvent, 'rrule' | 'recurringEventId'>,
  scope: EventRef['scope'],
): void {
  const isRecurring = Boolean(event.rrule || event.recurringEventId);
  if (!isRecurring) return;

  if (!scope) {
    throw new Error(
      'A recurring event requires an explicit edit scope; refusing to guess ' +
        'between changing one occurrence and changing the whole series.',
    );
  }

  if (!adapter.capabilities.recurrenceEditScopes.includes(scope)) {
    throw new Error(
      `${adapter.provider} cannot edit a recurring event with scope "${scope}". ` +
        `Supported: ${adapter.capabilities.recurrenceEditScopes.join(', ') || 'none'}.`,
    );
  }
}
