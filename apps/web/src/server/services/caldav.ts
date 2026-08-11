/**
 * CalDAV, joined up: connecting, pulling, and pushing.
 *
 * The adapter speaks the protocol and knows nothing about us; the reconciler
 * decides what a result means and knows nothing about a database. This module
 * is the only place the three meet, and it owns the two rules that make the
 * whole thing safe to run unattended:
 *
 *   - A CURSOR IS SAVED IN THE SAME TRANSACTION AS THE BATCH IT DESCRIBES.
 *     Save it separately and a crash between the two advances past changes that
 *     were never applied — changes that will then never be offered again.
 *
 *   - A WRITE LEAVES THROUGH THE OUTBOX, NEVER DIRECTLY. Every outbound change
 *     is a row with a unique idempotency key, retried until it lands. Combined
 *     with the adapter's deterministic UID, at-least-once delivery becomes
 *     effectively-once, and a lost response stops meaning a duplicate event.
 */
import 'server-only';
import {
  reconcile,
  type LocalEvent as ReconcilableEvent,
  type RemoteChange,
} from '@fluid/core';
import { features } from '@fluid/env';
import { openSecret, sealSecret } from '@fluid/crypto';
import { prisma, type Db } from '@fluid/db';
import {
  appBlockUid,
  createAppBlock,
  softDeleteAppBlock,
  updateAppBlock,
  upsertFromRemote,
} from '@fluid/db/repositories';
import {
  CalendarError,
  NotFoundError,
  PreconditionFailedError,
  type CalendarRef,
  type ConnectionRef,
  type RemoteEvent,
} from '@fluid/calendar';
import { CalDavAdapter } from '@fluid/calendar/adapters/caldav';

/** Bound into the AAD, so a credential row cannot be moved between users. */
const CREDENTIAL_PURPOSE = 'caldav-credentials';

/** Attempts before an outbound write is parked for a human to look at. */
const MAX_OUTBOX_ATTEMPTS = 5;

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

export interface SyncSummary {
  calendars: number;
  created: number;
  updated: number;
  deleted: number;
  pushed: number;
  /** Set when the deletion circuit breaker halted the sync. */
  halted?: string;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/**
 * Every adapter in this module is built here, so the localhost exemption is
 * decided in exactly one place. Scattering the flag would be how a development
 * convenience quietly reaches production.
 */
function adapterFor(): CalDavAdapter {
  return new CalDavAdapter({ allowLocalhost: features.caldavLocalhost });
}

function connectionRef(
  connection: { id: string; userId: string; encryptedCredentials: string },
): ConnectionRef {
  const credentials = JSON.parse(
    openSecret(connection.encryptedCredentials, {
      userId: connection.userId,
      purpose: CREDENTIAL_PURPOSE,
    }),
  ) as CalDavCredentials;

  return { id: connection.id, userId: connection.userId, provider: 'CALDAV', credentials };
}

/**
 * Link a CalDAV server.
 *
 * The credentials are proved before anything is stored: a connection row that
 * has never successfully talked to its server is just a future support
 * question. Discovery runs first, and only a working sign-in gets saved.
 */
export async function connectCalDav(
  userId: string,
  input: CalDavCredentials,
): Promise<{ connectionId: string; calendars: number }> {
  const adapter = adapterFor();

  const probe: ConnectionRef = {
    id: 'probe',
    userId,
    provider: 'CALDAV',
    credentials: input,
  };

  // Throws on a bad address or bad credentials, before anything is persisted.
  const remoteCalendars = await adapter.listCalendars(probe);

  if (remoteCalendars.length === 0) {
    throw new CalendarError(
      'Signed in, but that account has no calendars we can use. ' +
        'Check the address points at your calendar home.',
      false,
    );
  }

  const encryptedCredentials = sealSecret(JSON.stringify(input), {
    userId,
    purpose: CREDENTIAL_PURPOSE,
  });

  const accountIdentifier = `${input.username} @ ${new URL(input.serverUrl).host}`;

  const connection = await prisma.calendarConnection.upsert({
    where: {
      userId_provider_accountIdentifier: { userId, provider: 'CALDAV', accountIdentifier },
    },
    create: {
      userId,
      provider: 'CALDAV',
      accountIdentifier,
      encryptedCredentials,
      status: 'ACTIVE',
    },
    // Reconnecting with a new password must clear the previous failure, or the
    // connection stays paused for a problem that has just been fixed.
    update: {
      encryptedCredentials,
      status: 'ACTIVE',
      statusDetail: null,
      lastSyncError: null,
    },
  });

  const existing = await prisma.calendar.count({ where: { userId, isWriteTarget: true } });
  let claimedWriteTarget = existing > 0;

  for (const remote of remoteCalendars) {
    // The first writable calendar becomes the one that receives scheduled
    // blocks — a default, changeable in Settings, and constrained to one per
    // user by a partial unique index.
    const isWriteTarget = !claimedWriteTarget && remote.canWrite;
    if (isWriteTarget) claimedWriteTarget = true;

    await prisma.calendar.upsert({
      where: {
        connectionId_externalId: { connectionId: connection.id, externalId: remote.externalId },
      },
      create: {
        connectionId: connection.id,
        userId,
        externalId: remote.externalId,
        name: remote.name,
        timeZone: remote.timeZone,
        canWrite: remote.canWrite,
        isSelected: true,
        isWriteTarget,
      },
      update: { name: remote.name, timeZone: remote.timeZone, canWrite: remote.canWrite },
    });
  }

  return { connectionId: connection.id, calendars: remoteCalendars.length };
}

export async function disconnectCalDav(userId: string, connectionId: string): Promise<void> {
  // Marked disconnected rather than deleted: the events and the sync history
  // stay readable, and a reconnect does not look like a first-time link.
  await prisma.calendarConnection.updateMany({
    where: { id: connectionId, userId },
    data: { status: 'DISCONNECTED', statusDetail: 'Disconnected in Settings.' },
  });
}

export async function setWriteTarget(userId: string, calendarId: string): Promise<void> {
  const target = await prisma.calendar.findFirst({ where: { id: calendarId, userId } });
  if (!target) throw new NotFoundError(calendarId);
  if (!target.canWrite) {
    throw new CalendarError('That calendar is read-only, so blocks cannot be written to it.', false);
  }

  // One statement pair, one transaction: a partial unique index enforces
  // "at most one write target per user", so these cannot be separated.
  await prisma.$transaction([
    prisma.calendar.updateMany({ where: { userId, isWriteTarget: true }, data: { isWriteTarget: false } }),
    prisma.calendar.update({ where: { id: calendarId }, data: { isWriteTarget: true } }),
  ]);
}

// ---------------------------------------------------------------------------
// Pulling
// ---------------------------------------------------------------------------

export async function syncAllConnections(userId: string): Promise<SyncSummary> {
  const connections = await prisma.calendarConnection.findMany({
    where: { userId, provider: 'CALDAV', status: 'ACTIVE' },
  });

  const total: SyncSummary = { calendars: 0, created: 0, updated: 0, deleted: 0, pushed: 0 };

  for (const connection of connections) {
    const summary = await syncConnection(connection.id);
    total.calendars += summary.calendars;
    total.created += summary.created;
    total.updated += summary.updated;
    total.deleted += summary.deleted;
    total.pushed += summary.pushed;
    if (summary.halted) total.halted = summary.halted;
  }

  return total;
}

export async function syncConnection(connectionId: string): Promise<SyncSummary> {
  const connection = await prisma.calendarConnection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { calendars: true },
  });

  const adapter = adapterFor();
  const ref = connectionRef(connection);
  const startedAt = new Date();

  const summary: SyncSummary = { calendars: 0, created: 0, updated: 0, deleted: 0, pushed: 0 };

  for (const calendar of connection.calendars) {
    if (!calendar.isSelected) continue;

    const result = await pullCalendar(adapter, ref, calendar);
    summary.calendars += 1;
    summary.created += result.created;
    summary.updated += result.updated;
    summary.deleted += result.deleted;

    if (result.halted) {
      summary.halted = result.halted;

      // Halt the whole connection, not just this calendar. Whatever produced a
      // mass disappearance is unlikely to be limited to one collection, and
      // continuing to write while we do not understand the state is exactly
      // what the breaker exists to prevent.
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { status: 'NEEDS_ATTENTION', statusDetail: result.halted },
      });

      await prisma.syncLog.create({
        data: {
          connectionId: connection.id,
          direction: 'PULL',
          outcome: 'CIRCUIT_BROKEN',
          message: result.halted,
          startedAt,
          finishedAt: new Date(),
        },
      });

      return summary;
    }
  }

  await prisma.syncLog.create({
    data: {
      connectionId: connection.id,
      direction: 'PULL',
      outcome: 'SUCCESS',
      eventsCreated: summary.created,
      eventsUpdated: summary.updated,
      eventsDeleted: summary.deleted,
      message: `Pulled ${summary.calendars} calendar(s).`,
      startedAt,
      finishedAt: new Date(),
    },
  });

  await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: { lastSyncAt: new Date(), lastSyncError: null },
  });

  // Outbound work runs after the pull, so a block we are about to push is
  // reconciled against the freshest view of the calendar.
  await mirrorScheduledBlocks(connection.userId);
  summary.pushed = await drainOutbox(connectionId);

  return summary;
}

interface CalendarPullResult {
  created: number;
  updated: number;
  deleted: number;
  halted?: string;
}

async function pullCalendar(
  adapter: CalDavAdapter,
  connection: ConnectionRef,
  calendar: { id: string; externalId: string; timeZone: string; syncCursor: string | null },
): Promise<CalendarPullResult> {
  const ref: CalendarRef = {
    id: calendar.id,
    externalId: calendar.externalId,
    timeZone: calendar.timeZone,
  };

  let result = await adapter.pull(connection, ref, calendar.syncCursor ?? undefined);

  if (result.fullResyncRequired) {
    // The server rejected our cursor. Start again from a snapshot — under the
    // circuit breaker, which is the only reason a resync is safe to do at all.
    result = await adapter.pull(connection, ref, undefined);
  }

  const local = await prisma.event.findMany({
    where: { calendarId: calendar.id },
    select: { id: true, externalId: true, origin: true, startsAt: true, deletedAt: true },
  });

  const plan = reconcile({
    changes: result.changes.map(
      (event): RemoteChange => ({ externalId: event.externalId, isDeleted: event.isDeleted }),
    ),
    local: local as ReconcilableEvent[],
    isFullSnapshot: result.isFullSnapshot,
    ...(result.snapshotWindow ? { snapshotWindow: result.snapshotWindow } : {}),
  });

  if (plan.circuitBroken) {
    // The cursor is deliberately not advanced: the next attempt must see the
    // same state, so nothing is skipped once a person has looked at it.
    return { created: 0, updated: 0, deleted: 0, halted: plan.reason ?? 'Sync halted.' };
  }

  const known = new Set(local.map((event) => event.externalId).filter(Boolean) as string[]);
  const byExternalId = new Map(result.changes.map((event) => [event.externalId, event]));

  let created = 0;
  let updated = 0;

  // One transaction for the batch and its cursor together. A crash rolls both
  // back, so the next run re-reads the same changes rather than skipping them.
  await prisma.$transaction(async (tx) => {
    for (const change of plan.upserts) {
      const event = byExternalId.get(change.externalId);
      if (!event) continue;

      await writeRemoteEvent(tx, calendar.id, event);
      if (known.has(change.externalId)) updated += 1;
      else created += 1;
    }

    if (plan.tombstones.length > 0) {
      await tx.event.updateMany({
        where: { id: { in: plan.tombstones }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    await tx.calendar.update({
      where: { id: calendar.id },
      data: {
        syncCursor: result.nextCursor ?? null,
        needsFullResync: false,
      },
    });
  });

  return { created, updated, deleted: plan.tombstones.length };
}

async function writeRemoteEvent(db: Db, calendarId: string, event: RemoteEvent): Promise<void> {
  await upsertFromRemote(
    calendarId,
    event.externalId,
    {
      calendarId,
      externalId: event.externalId,
      iCalUid: event.iCalUid ?? null,
      etag: event.etag ?? null,
      sequence: event.sequence ?? null,
      title: event.title,
      description: event.description ?? null,
      location: event.location ?? null,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      isAllDay: event.isAllDay,
      timeZone: event.timeZone,
      // Verbatim, straight through. We never re-emit a rule we did not author.
      rrule: event.rrule ?? null,
      recurringEventId: event.recurringEventId ?? null,
      originalStartsAt: event.originalStartsAt ?? null,
      status: event.status,
      transparency: event.transparency,
      remoteUpdatedAt: event.remoteUpdatedAt ?? null,
      // The provider authored it, so the provider is the authority for it —
      // and the repository will never let the scheduler write to it.
      origin: 'EXTERNAL',
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

/**
 * Mirror accepted blocks into calendar events, and queue the writes.
 *
 * A `ScheduledBlock` is our own idea of a work session; the `Event` is its
 * shadow on a real calendar. Keeping them separate is what lets the app work
 * perfectly well with no calendar connected at all — the mirror simply does not
 * exist until there is somewhere to put it.
 */
export async function mirrorScheduledBlocks(userId: string): Promise<void> {
  const target = await prisma.calendar.findFirst({
    where: { userId, isWriteTarget: true, canWrite: true },
    include: { connection: true },
  });
  if (!target || target.connection.status !== 'ACTIVE') return;

  const blocks = await prisma.scheduledBlock.findMany({
    where: { task: { userId }, state: 'ACCEPTED' },
    include: { task: { select: { title: true } }, event: true },
  });

  for (const block of blocks) {
    if (!block.event) {
      const event = await createAppBlock({
        calendarId: target.id,
        iCalUid: appBlockUid(block.id),
        title: block.task.title,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        timeZone: target.timeZone,
      });

      await prisma.scheduledBlock.update({
        where: { id: block.id },
        data: { eventId: event.id },
      });

      await enqueue(target.connection.id, target.id, 'CREATE', event.id, `create:${event.id}`);
      continue;
    }

    const moved =
      block.event.startsAt.getTime() !== block.startsAt.getTime() ||
      block.event.endsAt.getTime() !== block.endsAt.getTime() ||
      block.event.title !== block.task.title;

    if (!moved || block.event.deletedAt) continue;

    await updateAppBlock(block.event.id, {
      title: block.task.title,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
    });

    // The key includes the times, so re-queueing the same move collapses into
    // one row while a genuinely new move gets its own.
    await enqueue(
      target.connection.id,
      target.id,
      'UPDATE',
      block.event.id,
      `update:${block.event.id}:${block.startsAt.getTime()}-${block.endsAt.getTime()}`,
    );
  }

  // A block that no longer exists leaves an orphaned event behind. Removing it
  // is the only deletion this module performs, and it only ever targets an
  // event we created.
  const orphans = await prisma.event.findMany({
    where: {
      calendarId: target.id,
      origin: 'APP_BLOCK',
      deletedAt: null,
      scheduledBlock: null,
    },
  });

  for (const orphan of orphans) {
    await softDeleteAppBlock(orphan.id, new Date());
    await enqueue(target.connection.id, target.id, 'DELETE', orphan.id, `delete:${orphan.id}`);
  }
}

async function enqueue(
  connectionId: string,
  calendarId: string,
  kind: 'CREATE' | 'UPDATE' | 'DELETE',
  eventId: string,
  idempotencyKey: string,
): Promise<void> {
  await prisma.pendingRemoteOp.upsert({
    where: { idempotencyKey },
    create: { connectionId, calendarId, kind, eventId, idempotencyKey },
    // Already queued. Re-queuing must not reset the attempt count, or a
    // failing write would retry forever instead of parking itself.
    update: {},
  });
}

/**
 * Send queued writes to the server.
 *
 * Every failure mode gets its own answer, because they need different ones: a
 * version conflict means someone edited the event elsewhere and our copy is
 * stale, a missing event means it was deleted at the source, and a network
 * error simply means "later".
 */
export async function drainOutbox(connectionId: string): Promise<number> {
  const connection = await prisma.calendarConnection.findUniqueOrThrow({
    where: { id: connectionId },
  });
  if (connection.status !== 'ACTIVE') return 0;

  const ops = await prisma.pendingRemoteOp.findMany({
    where: { connectionId, status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: 50,
    include: { calendar: true },
  });
  if (ops.length === 0) return 0;

  const adapter = adapterFor();
  const ref = connectionRef(connection);
  let pushed = 0;

  for (const op of ops) {
    const calendar: CalendarRef = {
      id: op.calendar.id,
      externalId: op.calendar.externalId,
      timeZone: op.calendar.timeZone,
    };

    try {
      await prisma.pendingRemoteOp.update({
        where: { id: op.id },
        data: { status: 'IN_FLIGHT', attempts: { increment: 1 } },
      });

      const event = op.eventId
        ? await prisma.event.findUnique({ where: { id: op.eventId } })
        : null;

      if (!event) {
        await prisma.pendingRemoteOp.update({
          where: { id: op.id },
          data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: 'Event no longer exists.' },
        });
        continue;
      }

      if (op.kind === 'CREATE') {
        const remote = await adapter.createEvent(ref, calendar, {
          iCalUid: event.iCalUid ?? appBlockUid(event.id),
          title: event.title,
          ...(event.description ? { description: event.description } : {}),
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timeZone: event.timeZone,
          transparency: event.transparency,
        });

        await prisma.event.update({
          where: { id: event.id },
          data: { externalId: remote.externalId, etag: remote.etag ?? null },
        });
      } else if (op.kind === 'UPDATE' && event.externalId) {
        const remote = await adapter.updateEvent(
          ref,
          calendar,
          { externalId: event.externalId, ...(event.etag ? { etag: event.etag } : {}) },
          { title: event.title, startsAt: event.startsAt, endsAt: event.endsAt },
        );

        await prisma.event.update({
          where: { id: event.id },
          data: { etag: remote.etag ?? null },
        });
      } else if (op.kind === 'DELETE' && event.externalId) {
        await adapter.deleteEvent(ref, calendar, {
          externalId: event.externalId,
          ...(event.etag ? { etag: event.etag } : {}),
        });
      }

      await prisma.pendingRemoteOp.update({
        where: { id: op.id },
        data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: null },
      });
      pushed += 1;
    } catch (error) {
      await recordFailure(op.id, op.attempts + 1, error);
    }
  }

  return pushed;
}

async function recordFailure(opId: string, attempts: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  // Someone edited our block in their own calendar client. That is user intent,
  // not a fault: the next pull adopts their version and pins it, so retrying
  // our stale copy would undo a deliberate change.
  if (error instanceof PreconditionFailedError) {
    await prisma.pendingRemoteOp.update({
      where: { id: opId },
      data: {
        status: 'FAILED',
        lastError: 'The event was changed in another calendar app; their version was kept.',
        completedAt: new Date(),
      },
    });
    return;
  }

  // Already gone at the server. Nothing left to do, and retrying a delete that
  // has happened would only ever produce the same answer.
  if (error instanceof NotFoundError) {
    await prisma.pendingRemoteOp.update({
      where: { id: opId },
      data: { status: 'SUCCEEDED', completedAt: new Date(), lastError: 'Already gone at the server.' },
    });
    return;
  }

  const retryable = !(error instanceof CalendarError) || error.retryable;
  const exhausted = attempts >= MAX_OUTBOX_ATTEMPTS;

  await prisma.pendingRemoteOp.update({
    where: { id: opId },
    data: {
      // Parked, never dropped. A write that cannot be delivered is something a
      // person needs to see, not something to discard quietly.
      status: !retryable || exhausted ? 'DEAD_LETTER' : 'PENDING',
      lastError: message.slice(0, 500),
      // Exponential backoff, so a server having a bad afternoon is not hammered.
      nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts, 60) * 30_000),
    },
  });
}
