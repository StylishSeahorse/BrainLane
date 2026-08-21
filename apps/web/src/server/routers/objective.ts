import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { localDayOfWeek, startOfLocalDay } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';

/**
 * Weekly objectives — a thin layer of "why" above the tasks.
 *
 * Deliberately not a project: no status workflow, no assignees, no nesting.
 * Three or four sentences about what the week is for. The value is entirely in
 * being asked the question on Monday and being shown the answer on Thursday,
 * which is lost the moment this grows into something that needs maintaining.
 *
 * Progress is derived from linked tasks and never entered by hand. A manual
 * percentage is a number people move to feel better; a task count is a fact.
 */

/** Local Monday 00:00 of the week containing `instant`. */
export function weekStartOf(instant: Date, timeZone: string): Date {
  const dayOfWeek = localDayOfWeek(instant, timeZone);
  // localDayOfWeek is 0 = Sunday; weeks here start on Monday, so Sunday is
  // six days into its week rather than the first day of the next one.
  const back = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return startOfLocalDay(instant, timeZone, -back);
}

export const objectiveRouter = router({
  /** Objectives for the week containing `week`, with progress from their tasks. */
  list: protectedProcedure
    .input(z.object({ week: z.coerce.date().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const weekStart = weekStartOf(input.week ?? new Date(), ctx.user.timeZone);

      const objectives = await prisma.objective.findMany({
        where: { userId: ctx.user.id, weekStart },
        include: {
          tasks: {
            select: { id: true, title: true, status: true, actualMinutes: true },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });

      return objectives.map((objective) => {
        const live = objective.tasks.filter((task) => task.status !== 'CANCELLED');
        const done = live.filter((task) => task.status === 'DONE');
        return {
          ...objective,
          tasks: live,
          doneCount: done.length,
          totalCount: live.length,
          minutesInvested: live.reduce((sum, task) => sum + task.actualMinutes, 0),
        };
      });
    }),

  create: protectedProcedure
    .input(
      z.object({
        title: z.string().trim().min(1, 'Give it a name.').max(140),
        notes: z.string().trim().max(2000).optional(),
        week: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const weekStart = weekStartOf(input.week ?? new Date(), ctx.user.timeZone);
      const count = await prisma.objective.count({
        where: { userId: ctx.user.id, weekStart },
      });

      // A week with fifteen objectives has none. The cap is a product
      // decision, not a storage one: the whole point is to force a choice.
      if (count >= 5) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Five is already more than a week can hold. Finish or drop one first.',
        });
      }

      return prisma.objective.create({
        data: {
          userId: ctx.user.id,
          title: input.title,
          notes: input.notes || null,
          weekStart,
          position: count,
        },
      });
    }),

  /** Tick an objective off, or un-tick it. */
  setAchieved: protectedProcedure
    .input(z.object({ id: z.string().cuid(), achieved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.objective.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: { achievedAt: input.achieved ? new Date() : null },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.objective.deleteMany({
        where: { id: input.id, userId: ctx.user.id },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),

  /**
   * Carry an unfinished objective into the current week.
   *
   * A new row rather than moving the old one, with `rolledFromId` pointing
   * back: the fact that something took three weeks is worth being able to see,
   * and silently editing last week's record would erase it.
   */
  rollForward: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const source = await prisma.objective.findFirst({
        where: { id: input.id, userId: ctx.user.id },
      });
      if (!source) throw new TRPCError({ code: 'NOT_FOUND' });

      const weekStart = weekStartOf(new Date(), ctx.user.timeZone);
      if (source.weekStart.getTime() === weekStart.getTime()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That is already this week.' });
      }

      const count = await prisma.objective.count({ where: { userId: ctx.user.id, weekStart } });

      return prisma.objective.create({
        data: {
          userId: ctx.user.id,
          title: source.title,
          notes: source.notes,
          weekStart,
          position: count,
          rolledFromId: source.id,
        },
      });
    }),

  /** Attach or detach a task. Null clears the link. */
  linkTask: protectedProcedure
    .input(z.object({ taskId: z.string().cuid(), objectiveId: z.string().cuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.objectiveId) {
        const owned = await prisma.objective.count({
          where: { id: input.objectiveId, userId: ctx.user.id },
        });
        if (owned === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      }

      const result = await prisma.task.updateMany({
        where: { id: input.taskId, userId: ctx.user.id },
        data: { objectiveId: input.objectiveId },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),
});
