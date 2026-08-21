import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma, type Prisma } from '@fluid/db';
import { startOfLocalDay } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';
import { weekShape } from './day';

/**
 * The week board: days as columns, work as cards.
 *
 * This is the surface where a task stops being a record and becomes a promise.
 * Everything here manipulates one field — `plannedFor` — plus the ordering
 * within a day, and deliberately nothing else. Committing to a day must not
 * silently rewrite an estimate, a deadline or a priority; a planning gesture
 * that quietly edits the thing being planned is how people lose trust in a
 * board.
 *
 * The scheduler is what turns those promises into times. This router never
 * writes a block.
 */

/** How many days the board shows at once. */
const BOARD_DAYS = 7;

/** Ordering gap, so a single insert rarely has to renumber its neighbours. */
const ORDER_STEP = 100;

/**
 * `satisfies` rather than `as const`: the latter makes the nested filter
 * arrays readonly, which Prisma's generated argument types reject. This keeps
 * the literal field selection — so the query's return type stays narrow — while
 * letting the arrays widen to the enum types Prisma expects.
 */
const cardSelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  energy: true,
  estimateMinutes: true,
  actualMinutes: true,
  adjustedEstimateMinutes: true,
  deadline: true,
  plannedFor: true,
  dayOrder: true,
  timeBucket: true,
  rolloverCount: true,
  rescheduleCount: true,
  completedAt: true,
  timerStartedAt: true,
  project: { select: { id: true, name: true, color: true } },
  area: { select: { id: true, name: true, color: true, countsTowardCapacity: true } },
  objective: { select: { id: true, title: true } },
  subtasks: { select: { id: true, status: true } },
  scheduledBlocks: {
    where: { state: { in: ['PROPOSED', 'ACCEPTED'] } },
    select: { id: true, startsAt: true, endsAt: true, state: true, isPinned: true },
    orderBy: { startsAt: 'asc' },
  },
} satisfies Prisma.TaskSelect;

/**
 * Renumber one day's cards, with `movedId` forced to `position`.
 *
 * Rewriting the whole column rather than computing a fractional index keeps
 * the stored order total and gap-free, which matters because two devices
 * dragging at once would otherwise converge on duplicate positions and the
 * column would reorder itself under the user.
 */
async function renumber(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  day: Date | null,
  movedId: string,
  /** Omitted means "append" — the caller does not know how long the day is. */
  position: number | undefined,
): Promise<void> {
  if (!day) return; // The backlog is ordered by bucket and deadline, not by hand.

  const siblings = await tx.task.findMany({
    where: { userId, plannedFor: day, status: { notIn: ['CANCELLED'] }, id: { not: movedId } },
    select: { id: true },
    orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
  });

  const ids = siblings.map((row) => row.id);
  const index = position === undefined ? ids.length : Math.max(0, Math.min(position, ids.length));
  ids.splice(index, 0, movedId);

  await Promise.all(
    ids.map((id, order) =>
      tx.task.update({ where: { id }, data: { dayOrder: order * ORDER_STEP } }),
    ),
  );
}

export const boardRouter = router({
  /**
   * A week of columns, plus the uncommitted pile beside them.
   *
   * Backlog cards carry any block the scheduler has already proposed for them,
   * so the board can show the difference plainly: a card on a day is something
   * the user chose, a backlog card with a time is something the AI suggested.
   * Both are real, and conflating them would hide which is which.
   */
  week: protectedProcedure
    .input(z.object({ weekStart: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const timeZone = ctx.user.timeZone;
      const start = startOfLocalDay(input.weekStart, timeZone);
      const days = Array.from({ length: BOARD_DAYS }, (_, offset) =>
        startOfLocalDay(start, timeZone, offset),
      );
      const rangeEnd = startOfLocalDay(start, timeZone, BOARD_DAYS);

      const [committed, backlog, shapes] = await Promise.all([
        prisma.task.findMany({
          where: {
            userId: ctx.user.id,
            parentId: null,
            status: { notIn: ['CANCELLED'] },
            plannedFor: { gte: start, lt: rangeEnd },
          },
          select: cardSelect,
          orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.task.findMany({
          where: {
            userId: ctx.user.id,
            parentId: null,
            status: { notIn: ['DONE', 'CANCELLED'] },
            archivedAt: null,
            plannedFor: null,
          },
          select: cardSelect,
          orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        }),
        weekShape(ctx.user.id, days, timeZone),
      ]);

      return {
        days: days.map((day, index) => ({
          day,
          shape: shapes[index]!,
          tasks: committed.filter(
            (task) =>
              task.plannedFor !== null &&
              startOfLocalDay(task.plannedFor, timeZone).getTime() === day.getTime(),
          ),
        })),
        backlog,
      };
    }),

  /**
   * Put a task on a day, move it between days, or send it back to the backlog.
   *
   * Committing promotes a BACKLOG task to READY, because the scheduler only
   * considers ready work and a promise the engine ignores is worse than no
   * promise at all. Going the other way deliberately does *not* demote: taking
   * a date off something is not the same as deciding it no longer matters.
   */
  commit: protectedProcedure
    .input(
      z.object({
        taskId: z.string().cuid(),
        /** null moves the card back to the backlog. */
        day: z.coerce.date().nullable(),
        /**
         * Index within the target day. Omit to append — callers that are
         * adding to a day they are not looking at (the morning ritual) have no
         * business guessing how many cards are already on it.
         */
        position: z.number().int().min(0).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const timeZone = ctx.user.timeZone;
      const day = input.day ? startOfLocalDay(input.day, timeZone) : null;

      const task = await prisma.task.findFirst({
        where: { id: input.taskId, userId: ctx.user.id },
        select: { id: true, status: true, plannedFor: true },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown task.' });

      // Moving a promise forward is the signal worth counting — it is what
      // predicts a task never happening. Placing it for the first time, or
      // pulling it back to the backlog, is not a rollover.
      const isPush =
        day !== null && task.plannedFor !== null && day.getTime() > task.plannedFor.getTime();

      await prisma.$transaction(async (tx) => {
        await tx.task.update({
          where: { id: task.id },
          data: {
            plannedFor: day,
            lastTouchedAt: new Date(),
            ...(isPush ? { rolloverCount: { increment: 1 } } : {}),
            ...(day && task.status === 'BACKLOG' ? { status: 'READY' as const } : {}),
            // A day is a commitment; a bucket is a vague intention. Holding
            // both would let the backlog claim work that is already on a day.
            ...(day ? { timeBucket: null, archivedAt: null } : {}),
          },
        });

        await renumber(tx, ctx.user.id, day, task.id, input.position);
      });

      return { ok: true };
    }),

  /** Reorder one day's column. The user's ranking, not the scheduler's. */
  reorder: protectedProcedure
    .input(
      z.object({
        day: z.coerce.date(),
        orderedIds: z.array(z.string().cuid()).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const day = startOfLocalDay(input.day, ctx.user.timeZone);

      // Scope the update by day as well as user, so a crafted id list cannot
      // reorder something that is not on this board.
      const owned = await prisma.task.findMany({
        where: { userId: ctx.user.id, plannedFor: day, id: { in: input.orderedIds } },
        select: { id: true },
      });
      const allowed = new Set(owned.map((row) => row.id));

      await prisma.$transaction(
        input.orderedIds
          .filter((id) => allowed.has(id))
          .map((id, order) =>
            prisma.task.update({ where: { id }, data: { dayOrder: order * ORDER_STEP } }),
          ),
      );

      return { moved: allowed.size };
    }),

  /**
   * Carry a day's unfinished promises to another day.
   *
   * Explicit, never automatic. Work silently reappearing on tomorrow is how a
   * planner accumulates a backlog nobody agreed to — and for the user this is
   * built for, waking up to yesterday's failures already stacked on today is
   * precisely the thing that makes the app unopenable.
   */
  rollover: protectedProcedure
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const timeZone = ctx.user.timeZone;
      const from = startOfLocalDay(input.from, timeZone);
      const to = startOfLocalDay(input.to, timeZone);
      if (from.getTime() === to.getTime()) return { moved: 0 };

      const stranded = await prisma.task.findMany({
        where: {
          userId: ctx.user.id,
          plannedFor: from,
          status: { notIn: ['DONE', 'CANCELLED'] },
        },
        select: { id: true },
        orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
      });
      if (stranded.length === 0) return { moved: 0 };

      // Land them after whatever is already on the target day, rather than
      // ahead of work that was chosen for it deliberately.
      const existing = await prisma.task.count({
        where: { userId: ctx.user.id, plannedFor: to, status: { notIn: ['CANCELLED'] } },
      });

      await prisma.$transaction(
        stranded.map((task, index) =>
          prisma.task.update({
            where: { id: task.id },
            data: {
              plannedFor: to,
              dayOrder: (existing + index) * ORDER_STEP,
              lastTouchedAt: new Date(),
              ...(to > from ? { rolloverCount: { increment: 1 } } : {}),
            },
          }),
        ),
      );

      return { moved: stranded.length };
    }),

  /**
   * Work that keeps being carried forward.
   *
   * The honest version of a nag: a count, and the options. A task moved eight
   * times is telling you something about its size or its relevance, and the
   * only wrong response is for the app to decide which.
   */
  chronic: protectedProcedure
    .input(z.object({ threshold: z.number().int().min(2).max(20).default(4) }).default({}))
    .query(async ({ ctx, input }) => {
      return prisma.task.findMany({
        where: {
          userId: ctx.user.id,
          status: { notIn: ['DONE', 'CANCELLED'] },
          archivedAt: null,
          rolloverCount: { gte: input.threshold },
        },
        select: {
          id: true,
          title: true,
          rolloverCount: true,
          estimateMinutes: true,
          plannedFor: true,
        },
        orderBy: { rolloverCount: 'desc' },
        take: 5,
      });
    }),
});
