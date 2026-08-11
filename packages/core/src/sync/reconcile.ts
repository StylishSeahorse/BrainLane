/**
 * Deciding what a sync result means — the most dangerous function in the app.
 *
 * A calendar sync has exactly one catastrophic failure mode: concluding that
 * events were deleted when they were not, and acting on it. Someone's meetings
 * are gone, in their real calendar, and no apology fixes it. Everything here is
 * arranged around making that outcome hard to reach.
 *
 * The three rules, in order of importance:
 *
 *   1. ABSENCE IS NOT DELETION. An event missing from a result means "not in
 *      what I was given". It only *may* mean deletion if the provider said the
 *      result was a complete snapshot, and even then only inside the window
 *      that snapshot covered.
 *
 *   2. A TOMBSTONE IS THE ONLY DELETE SIGNAL WE TRUST. The provider stating
 *      "this resource is gone" is a fact; inference is not.
 *
 *   3. WHEN A LOT DISAPPEARS AT ONCE, STOP. A correct mass deletion is rare;
 *      a bug or a half-returned response that looks like one is not. Halting
 *      and asking costs a user some staleness. Being wrong costs them their
 *      calendar.
 *
 * Pure: no database, no clock, no network. Every rule above is a unit test.
 */

export type EventOriginKind = 'EXTERNAL' | 'APP_BLOCK';

/** A change as reported by an adapter, reduced to what this decision needs. */
export interface RemoteChange {
  externalId: string;
  isDeleted: boolean;
}

/** What we currently hold for a calendar. */
export interface LocalEvent {
  id: string;
  externalId: string | null;
  origin: EventOriginKind;
  startsAt: Date;
  deletedAt: Date | null;
}

export interface ReconcileInput {
  changes: RemoteChange[];
  local: LocalEvent[];
  /** Whether `changes` is a complete listing rather than a delta. */
  isFullSnapshot: boolean;
  /**
   * The range a snapshot actually covered. Absent means the whole calendar.
   * Anything outside it was not examined, so it cannot be missing from it.
   */
  snapshotWindow?: { from: Date; to: Date };
  /** Share of examined events that may vanish before the breaker trips. */
  deletionThreshold?: number;
  /** Fewer disappearances than this are always treated as ordinary deletions. */
  minimumAbsences?: number;
}

export interface ReconcilePlan {
  /** External ids to write through. Empty when the breaker tripped. */
  upserts: RemoteChange[];
  /** Local event ids to tombstone. Empty when the breaker tripped. */
  tombstones: string[];
  /** Ids tombstoned because the provider issued an explicit deletion signal. */
  fromTombstoneSignal: string[];
  /** Ids tombstoned because a complete snapshot did not list them. */
  fromAbsence: string[];
  circuitBroken: boolean;
  /** Plain-language reason, shown in the sync log when the breaker trips. */
  reason?: string;
  /** Local events the snapshot actually covered. The breaker's denominator. */
  examined: number;
}

export const DEFAULT_DELETION_THRESHOLD = 0.2;
export const DEFAULT_MINIMUM_ABSENCES = 3;

export function reconcile(input: ReconcileInput): ReconcilePlan {
  const {
    changes,
    local,
    isFullSnapshot,
    snapshotWindow,
    deletionThreshold = DEFAULT_DELETION_THRESHOLD,
    minimumAbsences = DEFAULT_MINIMUM_ABSENCES,
  } = input;

  const upserts = changes.filter((change) => !change.isDeleted);

  const byExternalId = new Map<string, LocalEvent>();
  for (const event of local) {
    if (event.externalId) byExternalId.set(event.externalId, event);
  }

  // --- Explicit tombstones -------------------------------------------------
  const fromTombstoneSignal: string[] = [];
  for (const change of changes) {
    if (!change.isDeleted) continue;
    const match = byExternalId.get(change.externalId);
    // Already tombstoned locally: repeating it is harmless but pointless, and
    // leaving it out keeps the sync log's counts honest.
    if (match && !match.deletedAt) fromTombstoneSignal.push(match.id);
  }

  // --- Absence, but only from a complete snapshot --------------------------
  const fromAbsence: string[] = [];
  let examined = 0;

  if (isFullSnapshot) {
    const present = new Set(changes.map((change) => change.externalId));

    const covered = local.filter((event) => {
      // We are the authority for our own blocks. A block not yet pushed is
      // absent from every provider listing, and deleting it on that basis
      // would erase the user's schedule the first time they connected a
      // calendar.
      if (event.origin !== 'EXTERNAL') return false;
      if (event.deletedAt) return false;
      if (!event.externalId) return false;
      if (!snapshotWindow) return true;
      // Outside the window is unexamined, not missing.
      return event.startsAt >= snapshotWindow.from && event.startsAt <= snapshotWindow.to;
    });

    examined = covered.length;

    for (const event of covered) {
      if (!present.has(event.externalId!)) fromAbsence.push(event.id);
    }
  }

  // --- The circuit breaker -------------------------------------------------
  //
  // Applies only to absence, never to explicit tombstones: a provider that
  // states fifty deletions is reporting something it knows, and refusing to
  // believe it would leave the calendar permanently wrong.
  if (
    fromAbsence.length >= minimumAbsences &&
    examined > 0 &&
    fromAbsence.length / examined > deletionThreshold
  ) {
    const percent = Math.round((fromAbsence.length / examined) * 100);
    return {
      upserts: [],
      tombstones: [],
      fromTombstoneSignal: [],
      fromAbsence: [],
      circuitBroken: true,
      reason:
        `${fromAbsence.length} of ${examined} events (${percent}%) were missing from this sync. ` +
        'That is more than a normal amount of deleting, so nothing was changed and syncing is ' +
        'paused until you have had a look.',
      examined,
    };
  }

  return {
    upserts,
    tombstones: [...new Set([...fromTombstoneSignal, ...fromAbsence])],
    fromTombstoneSignal,
    fromAbsence,
    circuitBroken: false,
    examined,
  };
}
