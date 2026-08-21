import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { startOfLocalDay } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';

/**
 * Areas — the context a piece of work belongs to.
 *
 * One level above projects: Work, Personal, the band, the house. Two things
 * hang off them and nothing else does, deliberately, because a taxonomy that
 * does not change any behaviour is just filing:
 *
 *   - Colour, so a week can be read at a glance without reading it.
 *   - `countsTowardCapacity`, which decides whether time in this area is work
 *     the day owes or simply time the day has lost.
 *
 * Deleting an area never deletes work. The foreign keys are `SetNull`, so the
 * tasks survive with no context — losing a label must not be a way to lose the
 * thing it was labelling.
 */

const nameInput = z.string().trim().min(1, 'Give the area a name.').max(40);
/** Hex, because that is what the colour input emits and what CSS consumes. */
const colorInput = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour.')
  .optional()
  .nullable();

export const areaRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return prisma.area.findMany({
      where: { userId: ctx.user.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { tasks: true, projects: true } },
      },
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: nameInput,
        color: colorInput,
        countsTowardCapacity: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.area.count({ where: { userId: ctx.user.id } });
      if (existing >= 12) {
        // Not a technical limit. Past a dozen contexts the colours stop being
        // distinguishable and the grouping stops doing the one job it has.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Twelve areas is already more than anyone can hold in mind. Reuse one instead.',
        });
      }

      const clash = await prisma.area.count({
        where: { userId: ctx.user.id, name: input.name },
      });
      if (clash > 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'You already have an area with that name.' });
      }

      return prisma.area.create({
        data: {
          userId: ctx.user.id,
          name: input.name,
          color: input.color ?? null,
          countsTowardCapacity: input.countsTowardCapacity,
          position: existing,
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: nameInput.optional(),
        color: colorInput,
        countsTowardCapacity: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.area.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.countsTowardCapacity !== undefined
            ? { countsTowardCapacity: input.countsTowardCapacity }
            : {}),
        },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown area.' });
    }),

  /** Removes the label, never the work. */
  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.area.deleteMany({
        where: { id: input.id, userId: ctx.user.id },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown area.' });
    }),

  /** Put a task in a context, or take it out of one. */
  assign: protectedProcedure
    .input(z.object({ taskId: z.string().cuid(), areaId: z.string().cuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.areaId) {
        const owned = await prisma.area.count({
          where: { id: input.areaId, userId: ctx.user.id },
        });
        if (owned === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown area.' });
      }

      const result = await prisma.task.updateMany({
        where: { id: input.taskId, userId: ctx.user.id },
        data: { areaId: input.areaId, lastTouchedAt: new Date() },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown task.' });
    }),

  /**
   * Where the time actually went, by context.
   *
   * Sunsama's "personal versus work" report. Built from logged minutes rather
   * than from estimates, because the gap between the two is the entire reason
   * anyone looks at this screen.
   */
  timeSpent: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(7) }).default({}))
    .query(async ({ ctx, input }) => {
      const since = startOfLocalDay(new Date(), ctx.user.timeZone, -(input.days - 1));

      const tasks = await prisma.task.findMany({
        where: {
          userId: ctx.user.id,
          actualMinutes: { gt: 0 },
          OR: [{ completedAt: { gte: since } }, { lastTouchedAt: { gte: since } }],
        },
        select: {
          actualMinutes: true,
          area: { select: { id: true, name: true, color: true, countsTowardCapacity: true } },
        },
      });

      const totals = new Map<
        string,
        { id: string | null; name: string; color: string | null; minutes: number; counts: boolean }
      >();

      for (const task of tasks) {
        const key = task.area?.id ?? 'none';
        const current = totals.get(key) ?? {
          id: task.area?.id ?? null,
          name: task.area?.name ?? 'No area',
          color: task.area?.color ?? null,
          minutes: 0,
          counts: task.area?.countsTowardCapacity ?? true,
        };
        current.minutes += task.actualMinutes;
        totals.set(key, current);
      }

      return [...totals.values()].sort((a, b) => b.minutes - a.minutes);
    }),
});
