/**
 * Event repository — the ownership boundary.
 *
 * Everything the scheduler does to the calendar goes through here. The type
 * signatures make the dangerous operation unavailable rather than merely
 * discouraged: there is no exported function that lets scheduling code name an
 * EXTERNAL event as a write target.
 *
 * Three layers enforce the same rule, deliberately:
 *   1. This module — the scheduler's only vocabulary is `*AppBlock`.
 *   2. A runtime origin check before each write, for callers reached by a path
 *      the types did not cover (raw ids from a queue payload, say).
 *   3. Database triggers (see the init migration), which hold even if someone
 *      bypasses this file entirely.
 *
 * Three layers is not paranoia about one bug. It is that the failure mode —
 * deleting a user's real meetings — destroys trust permanently, and a calendar
 * tool that has lost your trust is worthless even after the bug is fixed.
 */
import { prisma, type Db } from '../client';
import { EventOrigin, type Event, type Prisma } from '../index';

/** Raised when a write would have touched an event we do not own. */
export class EventOwnershipError extends Error {
  constructor(
    readonly eventId: string,
    readonly actualOrigin: EventOrigin | 'MISSING',
  ) {
    super(
      `Refused to modify event ${eventId}: origin is ${actualOrigin}, ` +
        `but only APP_BLOCK events may be modified by the scheduler.`,
    );
    this.name = 'EventOwnershipError';
  }
}

/** Fields the scheduler is allowed to change on a block it owns. */
export interface AppBlockPatch {
  title?: string;
  description?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  transparency?: 'BUSY' | 'FREE';
}

/** Everything needed to create a block we own. */
export interface AppBlockDraft {
  calendarId: string;
  /** Deterministic — `fluid-<blockId>@fluid.local`. See `appBlockUid`. */
  iCalUid: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
}

/**
 * The UID we stamp on every event we create.
 *
 * Deterministic on purpose: it is what makes a retried create idempotent. If a
 * push succeeded but the response was lost, the retry finds this UID already
 * present at the provider and adopts the existing event instead of creating a
 * duplicate. Duplicated events are the single most common way calendar sync
 * loses a user's trust.
 */
export function appBlockUid(blockId: string): string {
  return `fluid-${blockId}@fluid.local`;
}

/**
 * Assert we own an event, and return it. Every mutating helper below calls
 * this first.
 */
async function requireAppBlock(db: Db, eventId: string): Promise<Event> {
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event) throw new EventOwnershipError(eventId, 'MISSING');
  if (event.origin !== EventOrigin.APP_BLOCK) {
    throw new EventOwnershipError(eventId, event.origin);
  }
  return event;
}

// ---------------------------------------------------------------------------
// Writes the scheduler is allowed to perform
// ---------------------------------------------------------------------------

export async function createAppBlock(draft: AppBlockDraft, db: Db = prisma): Promise<Event> {
  return db.event.create({
    data: {
      calendarId: draft.calendarId,
      iCalUid: draft.iCalUid,
      title: draft.title,
      description: draft.description ?? null,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      timeZone: draft.timeZone,
      // Not a parameter. A block created through this function is ours by
      // construction, and origin is immutable thereafter.
      origin: EventOrigin.APP_BLOCK,
    },
  });
}

export async function updateAppBlock(
  eventId: string,
  patch: AppBlockPatch,
  db: Db = prisma,
): Promise<Event> {
  await requireAppBlock(db, eventId);
  return db.event.update({ where: { id: eventId }, data: patch });
}

/**
 * Soft-delete a block we own.
 *
 * Soft, not hard, and this is not incidental: a tombstone that turns out to be
 * wrong can be undone, a DELETE cannot. Sync bugs are discovered after the
 * fact, so every deletion path in this system has to be reversible.
 */
export async function softDeleteAppBlock(
  eventId: string,
  when: Date,
  db: Db = prisma,
): Promise<Event> {
  await requireAppBlock(db, eventId);
  return db.event.update({ where: { id: eventId }, data: { deletedAt: when } });
}

export async function restoreAppBlock(eventId: string, db: Db = prisma): Promise<Event> {
  await requireAppBlock(db, eventId);
  return db.event.update({ where: { id: eventId }, data: { deletedAt: null } });
}

// ---------------------------------------------------------------------------
// Writes originating from the sync layer
//
// These may touch EXTERNAL events, because the provider is the authority for
// them. They are separated from the scheduler's vocabulary above so that the
// distinction is visible at every call site.
// ---------------------------------------------------------------------------

/**
 * Apply a change the provider reported. Reserved for the sync engine, which is
 * mirroring a decision the provider already made — it is not originating one.
 */
export async function upsertFromRemote(
  calendarId: string,
  externalId: string,
  data: Prisma.EventUncheckedCreateInput,
  db: Db = prisma,
): Promise<Event> {
  return db.event.upsert({
    where: { calendarId_externalId: { calendarId, externalId } },
    create: data,
    update: {
      title: data.title,
      description: data.description,
      location: data.location,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      isAllDay: data.isAllDay,
      timeZone: data.timeZone,
      rrule: data.rrule,
      recurringEventId: data.recurringEventId,
      originalStartsAt: data.originalStartsAt,
      status: data.status,
      transparency: data.transparency,
      etag: data.etag,
      sequence: data.sequence,
      remoteUpdatedAt: data.remoteUpdatedAt,
      // Note the absentees: `origin` is immutable, and `deletedAt` is only ever
      // cleared by an explicit restore. An upsert must not resurrect a
      // tombstoned event as a side effect.
    },
  });
}

/**
 * Tombstone an event the provider explicitly told us was deleted.
 *
 * "Explicitly" is doing real work in that sentence. This is only ever called
 * with a provider-issued deletion signal — a `cancelled` status or a delete
 * tombstone. It is never called because an event was *absent* from a listing:
 * absence means "not in this page of results", and treating it as deletion is
 * how a full resync turns into mass data loss.
 */
export async function tombstoneFromRemote(
  eventId: string,
  when: Date,
  db: Db = prisma,
): Promise<Event> {
  return db.event.update({ where: { id: eventId }, data: { deletedAt: when } });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Events that consume schedulable time in a window. This is the scheduler's
 * view of "when am I busy" — it deliberately includes EXTERNAL events (we must
 * schedule around them) while the write helpers above exclude them.
 */
export async function findBusyInRange(
  userId: string,
  from: Date,
  to: Date,
  db: Db = prisma,
): Promise<Event[]> {
  return db.event.findMany({
    where: {
      calendar: { userId, isSelected: true },
      deletedAt: null,
      status: { not: 'CANCELLED' },
      transparency: 'BUSY',
      // Overlap, not containment: an event starting before the window and
      // ending inside it still blocks time.
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    orderBy: { startsAt: 'asc' },
  });
}

export async function findByUid(
  calendarId: string,
  iCalUid: string,
  db: Db = prisma,
): Promise<Event | null> {
  return db.event.findUnique({ where: { calendarId_iCalUid: { calendarId, iCalUid } } });
}

export async function findByExternalId(
  calendarId: string,
  externalId: string,
  db: Db = prisma,
): Promise<Event | null> {
  return db.event.findUnique({ where: { calendarId_externalId: { calendarId, externalId } } });
}
