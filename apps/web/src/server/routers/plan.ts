import 'server-only';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { minutesBetween } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';
import { acceptPlan, buildPlan, rejectPlan } from '../services/planning';

export const planRouter = router({
  /** Re-plan. `trigger` becomes the "because…" in the diff the user reads. */
  build: protectedProcedure
    .input(
      z
        .object({
          trigger: z
            .enum([
              'manual',
              'task_skipped',
              'task_overran',
              'new_urgent_task',
              'task_completed',
              'external_event_conflict',
              'settings_changed',
            ])
            .default('manual'),
        })
        .default({ trigger: 'manual' }),
    )
    .mutation(async ({ ctx, input }) => buildPlan(ctx.user.id, input.trigger)),

  accept: protectedProcedure
    .input(z.object({ planVersionId: z.string().cuid(), auto: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      await acceptPlan(ctx.user.id, input.planVersionId, input.auto);
    }),

  reject: protectedProcedure
    .input(z.object({ planVersionId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await rejectPlan(ctx.user.id, input.planVersionId);
    }),

  pending: protectedProcedure.query(async ({ ctx }) => {
    return prisma.planVersion.findFirst({
      where: { userId: ctx.user.id, status: 'PROPOSED' },
      include: { changes: true },
      orderBy: { createdAt: 'desc' },
    });
  }),

  /** Blocks in a window, for the calendar and the day view. */
  blocks: protectedProcedure
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const [blocks, events] = await Promise.all([
        prisma.scheduledBlock.findMany({
          where: {
            task: { userId: ctx.user.id },
            state: { in: ['PROPOSED', 'ACCEPTED', 'COMPLETED'] },
            startsAt: { lt: input.to },
            endsAt: { gt: input.from },
          },
          include: {
            task: {
              select: {
                id: true,
                title: true,
                energy: true,
                priority: true,
                project: { select: { name: true, color: true } },
              },
            },
          },
          orderBy: { startsAt: 'asc' },
        }),
        prisma.event.findMany({
          where: {
            calendar: { userId: ctx.user.id, isSelected: true },
            origin: 'EXTERNAL',
            deletedAt: null,
            status: { not: 'CANCELLED' },
            startsAt: { lt: input.to },
            endsAt: { gt: input.from },
          },
          orderBy: { startsAt: 'asc' },
        }),
      ]);

      return { blocks, events };
    }),

  /**
   * Deadline runway.
   *
   * Counts remaining *scheduled working sessions* before each deadline, not
   * calendar days. "Three days left" and "one 45-minute session left" describe
   * the same instant and produce completely different decisions — the second
   * is the one that makes time blindness concrete.
   */
  runway: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();

    const tasks = await prisma.task.findMany({
      where: {
        userId: ctx.user.id,
        deadline: { not: null, gte: now },
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
      include: {
        scheduledBlocks: {
          where: { state: { in: ['PROPOSED', 'ACCEPTED'] }, startsAt: { gte: now } },
        },
      },
      orderBy: { deadline: 'asc' },
      take: 6,
    });

    return tasks.map((task) => {
      const before = task.scheduledBlocks.filter(
        (block) => task.deadline && block.endsAt <= task.deadline,
      );
      const scheduledMinutes = before.reduce(
        (sum, block) => sum + minutesBetween(block.startsAt, block.endsAt),
        0,
      );
      const remaining = Math.max(0, task.estimateMinutes - task.actualMinutes);

      return {
        taskId: task.id,
        title: task.title,
        deadline: task.deadline!,
        sessionsBeforeDeadline: before.length,
        scheduledMinutes,
        remainingMinutes: remaining,
        // The honest bit: is the work that remains actually on the calendar?
        shortfallMinutes: Math.max(0, remaining - scheduledMinutes),
        daysRemaining: Math.ceil(
          (task.deadline!.getTime() - now.getTime()) / 86_400_000,
        ),
      };
    });
  }),

  /** Estimate-vs-actual accuracy, for the weekly review. */
  estimateAccuracy: protectedProcedure.query(async ({ ctx }) => {
    const samples = await prisma.timeEstimateSample.findMany({
      where: { userId: ctx.user.id },
      orderBy: { recordedAt: 'desc' },
      take: 100,
    });

    if (samples.length === 0) return { sampleCount: 0, byCategory: [] };

    const groups = new Map<string, { estimated: number; actual: number; count: number }>();
    for (const sample of samples) {
      const entry = groups.get(sample.category) ?? { estimated: 0, actual: 0, count: 0 };
      entry.estimated += sample.estimatedMinutes;
      entry.actual += sample.actualMinutes;
      entry.count += 1;
      groups.set(sample.category, entry);
    }

    return {
      sampleCount: samples.length,
      byCategory: [...groups.entries()].map(([category, entry]) => ({
        category,
        count: entry.count,
        // >1 means the work takes longer than expected — the common direction.
        ratio: entry.estimated > 0 ? entry.actual / entry.estimated : 1,
      })),
    };
  }),
});
