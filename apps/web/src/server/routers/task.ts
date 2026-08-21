import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma, type Db, type Task } from '@fluid/db';
import { features } from '@fluid/env';
import { withFallback } from '@fluid/ai';
import { localDayOfWeek, parseBraindump, startOfLocalDay } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';
import { getAiProvider } from '../services/ai-provider';

/**
 * Every mutation is scoped by `userId` in its WHERE clause rather than
 * fetch-then-check. A row belonging to someone else is simply not found, so
 * there is no window between the check and the write.
 */
const taskInput = z.object({
  title: z.string().trim().min(1, 'Give the task a name.').max(200),
  notes: z.string().trim().max(5000).optional(),
  projectId: z.string().cuid().optional().nullable(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  energy: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  estimateMinutes: z.number().int().min(5).max(480).default(30),
  deadline: z.coerce.date().optional().nullable(),
  isSplittable: z.boolean().default(true),
  timeBucket: z
    .enum(['SOON', 'THIS_MONTH', 'THIS_QUARTER', 'LATER', 'SOMEDAY'])
    .optional()
    .nullable(),
});

/** Three or more moves is the avoidance signal, per the product spec. */
const AVOIDANCE_RESCHEDULE_THRESHOLD = 3;
const AVOIDANCE_STALE_DAYS = 7;

/**
 * Deferrals before we suggest a task leaves the daily list entirely.
 *
 * Higher than the avoidance threshold on purpose: the first conversation is
 * "shall we make this smaller?", and only after that has failed repeatedly is
 * "this does not belong in your day" the honest thing to say.
 */
const STALE_DEFERRAL_THRESHOLD = 6;

const timeBucket = z.enum(['SOON', 'THIS_MONTH', 'THIS_QUARTER', 'LATER', 'SOMEDAY']);

export const taskRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ includeDone: z.boolean().default(false) })
        .default({ includeDone: false }),
    )
    .query(async ({ ctx, input }) => {
      return prisma.task.findMany({
        where: {
          userId: ctx.user.id,
          parentId: null,
          ...(input.includeDone ? {} : { status: { notIn: ['DONE', 'CANCELLED'] } }),
        },
        include: {
          project: { select: { id: true, name: true, color: true } },
          subtasks: { orderBy: { createdAt: 'asc' } },
          scheduledBlocks: {
            where: { state: { in: ['PROPOSED', 'ACCEPTED'] } },
            orderBy: { startsAt: 'asc' },
          },
        },
        orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      });
    }),

  create: protectedProcedure.input(taskInput).mutation(async ({ ctx, input }) => {
    // The project seeds the area, once, at creation. After that the task owns
    // it — so re-filing a project later never silently reclassifies work that
    // has already been scheduled and counted.
    let areaId: string | null = null;
    if (input.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: input.projectId, userId: ctx.user.id },
        select: { areaId: true },
      });
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Unknown project.' });
      areaId = project.areaId;
    }

    return prisma.task.create({
      data: {
        userId: ctx.user.id,
        title: input.title,
        notes: input.notes ?? null,
        projectId: input.projectId ?? null,
        areaId,
        priority: input.priority,
        energy: input.energy,
        estimateMinutes: input.estimateMinutes,
        deadline: input.deadline ?? null,
        isSplittable: input.isSplittable,
        timeBucket: input.timeBucket ?? null,
        status: 'READY',
      },
    });
  }),

  /**
   * The backlog, grouped by horizon.
   *
   * Work with no bucket falls into SOON rather than a sixth "unsorted" pile.
   * An inbox that has to be processed before the list is usable is the thing
   * that kills backlogs; a default that is occasionally wrong is cheaper than
   * a chore that is always there.
   */
  backlog: protectedProcedure.query(async ({ ctx }) => {
    const tasks = await prisma.task.findMany({
      where: {
        userId: ctx.user.id,
        parentId: null,
        status: { notIn: ['DONE', 'CANCELLED'] },
        archivedAt: null,
      },
      include: {
        project: { select: { id: true, name: true, color: true } },
        scheduledBlocks: {
          where: { state: { in: ['PROPOSED', 'ACCEPTED'] } },
          select: { id: true },
        },
      },
      orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    });

    const buckets = ['SOON', 'THIS_MONTH', 'THIS_QUARTER', 'LATER', 'SOMEDAY'] as const;
    return buckets.map((bucket) => ({
      bucket,
      tasks: tasks.filter((task) => (task.timeBucket ?? 'SOON') === bucket),
    }));
  }),

  /**
   * Parse a braindump without writing anything.
   *
   * Split from `commitBraindump` so the user always sees what was understood
   * before it becomes real. Capture is the moment ADHD users most need to be
   * trusted quickly and least need a surprise — six half-right tasks appearing
   * silently is worse than the box they were avoiding.
   */
  parseBraindump: protectedProcedure
    .input(z.object({ text: z.string().trim().min(1).max(4000) }))
    .query(async ({ ctx, input }) => {
      return parseBraindump(input.text, {
        todayDayOfWeek: localDayOfWeek(new Date(), ctx.user.timeZone),
      });
    }),

  /** Create the tasks the user confirmed, exactly as shown. */
  commitBraindump: protectedProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(200),
              estimateMinutes: z.number().int().min(5).max(480).default(30),
              bucket: timeBucket.nullable().default(null),
              priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
              dueInDays: z.number().int().min(0).max(365).nullable().default(null),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const timeZone = ctx.user.timeZone;

      const created = await prisma.task.createMany({
        data: input.items.map((item) => ({
          userId: ctx.user.id,
          title: item.title,
          estimateMinutes: item.estimateMinutes,
          priority: item.priority,
          timeBucket: item.bucket,
          // End of the named day, not the moment of parsing: "due Friday"
          // means by the end of Friday, and anything else quietly loses hours.
          deadline:
            item.dueInDays == null
              ? null
              : startOfLocalDay(new Date(), timeZone, item.dueInDays + 1),
          status: 'READY' as const,
        })),
      });

      return { count: created.count };
    }),

  setBucket: protectedProcedure
    .input(z.object({ id: z.string().cuid(), bucket: timeBucket.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.task.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: { timeBucket: input.bucket, lastTouchedAt: new Date() },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),

  /**
   * Tasks that have been pushed so many times they are clearly not going to
   * happen by being asked about again tomorrow.
   *
   * Surfaced as a question, never acted on automatically. "You have moved this
   * eight times" is a fact worth showing; deciding on the user's behalf that
   * it no longer matters is not ours to make.
   */
  stale: protectedProcedure.query(async ({ ctx }) => {
    return prisma.task.findMany({
      where: {
        userId: ctx.user.id,
        parentId: null,
        status: { notIn: ['DONE', 'CANCELLED'] },
        archivedAt: null,
        rescheduleCount: { gte: STALE_DEFERRAL_THRESHOLD },
      },
      select: { id: true, title: true, rescheduleCount: true, lastTouchedAt: true },
      orderBy: { rescheduleCount: 'desc' },
      take: 5,
    });
  }),

  /**
   * Move a stale task off the daily list without deleting it.
   *
   * Archiving clears the deferral count as well: the task is starting a new
   * life in the backlog, and carrying "moved 8 times" forward would mean it
   * gets flagged again the moment it is picked back up.
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid(), bucket: timeBucket.default('SOMEDAY') }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.task.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: {
          archivedAt: new Date(),
          timeBucket: input.bucket,
          earliestStart: null,
          rescheduleCount: 0,
          lastTouchedAt: new Date(),
        },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      await prisma.scheduledBlock.deleteMany({
        where: { taskId: input.id, state: { in: ['PROPOSED', 'ACCEPTED'] } },
      });
    }),

  /** Undo an archive — reversibility is the price of an automated suggestion. */
  unarchive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.task.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: { archivedAt: null, lastTouchedAt: new Date() },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),

  /**
   * What this kind of task has actually taken before.
   *
   * Plain statistics over the user's own history — no model call. The median
   * is the headline because a single four-hour outlier should not drag the
   * suggestion up for every future twenty-minute email.
   */
  estimateSuggestion: protectedProcedure
    .input(z.object({ title: z.string().trim().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const category = categoryFor(input.title);
      const samples = await prisma.timeEstimateSample.findMany({
        where: { userId: ctx.user.id, category },
        select: { actualMinutes: true },
        orderBy: { recordedAt: 'desc' },
        take: 30,
      });

      // Two points is a coincidence, not a pattern. Saying nothing is better
      // than a confident number drawn from one previous afternoon.
      if (samples.length < 3) return { category, sampleCount: samples.length, suggestion: null };

      const sorted = samples.map((sample) => sample.actualMinutes).sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
      const average = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

      return {
        category,
        sampleCount: sorted.length,
        suggestion: {
          // Rounded to five minutes: the precision of "37 minutes" is fake,
          // and a round number is easier to accept or overrule.
          medianMinutes: Math.max(5, Math.round(median / 5) * 5),
          averageMinutes: Math.max(5, Math.round(average / 5) * 5),
        },
      };
    }),

  update: protectedProcedure
    .input(taskInput.partial().extend({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const result = await prisma.task.updateMany({
        where: { id, userId: ctx.user.id },
        data: { ...patch, lastTouchedAt: new Date() },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      return prisma.task.findUniqueOrThrow({ where: { id } });
    }),

  complete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const task = await tx.task.findFirst({
          where: { id: input.id, userId: ctx.user.id },
        });
        if (!task) throw new TRPCError({ code: 'NOT_FOUND' });

        await tx.task.update({
          where: { id: task.id },
          data: { status: 'DONE', completedAt: now, lastTouchedAt: now },
        });

        // Feed the estimation coach. Only real observations count — a task
        // completed without any tracked time teaches us nothing.
        if (task.actualMinutes > 0) {
          await tx.timeEstimateSample.create({
            data: {
              userId: ctx.user.id,
              taskId: task.id,
              category: categoryFor(task.title),
              estimatedMinutes: task.estimateMinutes,
              actualMinutes: task.actualMinutes,
            },
          });
        }

        // Free the calendar: proposed blocks vanish, accepted ones are marked
        // complete rather than deleted, so the week's history stays honest.
        await tx.scheduledBlock.deleteMany({
          where: { taskId: task.id, state: 'PROPOSED' },
        });
        await tx.scheduledBlock.updateMany({
          where: { taskId: task.id, state: 'ACCEPTED' },
          data: { state: 'COMPLETED' },
        });
      });
    }),

  /**
   * Put a finished task back.
   *
   * Completion is one tap with no confirmation, which is right — asking "are
   * you sure you did that?" is friction in exactly the wrong place. The
   * bargain is that it has to be genuinely reversible, and reversible means
   * undoing the side effects too, not just flipping the status back.
   */
  uncomplete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const task = await tx.task.findFirst({
          where: { id: input.id, userId: ctx.user.id, status: 'DONE' },
        });
        if (!task) throw new TRPCError({ code: 'NOT_FOUND' });

        await tx.task.update({
          where: { id: task.id },
          data: { status: 'READY', completedAt: null, lastTouchedAt: now },
        });

        // Drop the sample completing it produced. Leaving it would teach the
        // estimation coach from an event the user just said did not happen.
        const sample = await tx.timeEstimateSample.findFirst({
          where: { taskId: task.id, userId: ctx.user.id },
          orderBy: { recordedAt: 'desc' },
        });
        if (sample) await tx.timeEstimateSample.delete({ where: { id: sample.id } });

        // Only sessions still ahead of us go back to ACCEPTED. A block whose
        // time has already passed was genuinely sat through, and marking it
        // upcoming again would put a session in the past on the calendar.
        await tx.scheduledBlock.updateMany({
          where: { taskId: task.id, state: 'COMPLETED', endsAt: { gt: now } },
          data: { state: 'ACCEPTED' },
        });
      });
    }),

  /** Finished in the last day, so the Tasks page can offer them back. */
  recentlyCompleted: protectedProcedure.query(async ({ ctx }) => {
    const since = new Date();
    since.setDate(since.getDate() - 1);

    return prisma.task.findMany({
      where: {
        userId: ctx.user.id,
        parentId: null,
        status: 'DONE',
        completedAt: { gte: since },
      },
      select: { id: true, title: true, completedAt: true, actualMinutes: true },
      orderBy: { completedAt: 'desc' },
      take: 5,
    });
  }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.task.deleteMany({
        where: { id: input.id, userId: ctx.user.id },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),

  /**
   * Defer a task, and count it.
   *
   * The counter is the whole point: a deferral is not just a silenced alert,
   * it is the signal that feeds avoidance detection. Snoozing something four
   * times is information the product should notice and act on gently.
   */
  defer: protectedProcedure
    .input(z.object({ id: z.string().cuid(), days: z.number().int().min(1).max(30).default(1) }))
    .mutation(async ({ ctx, input }) => {
      const task = await prisma.task.findFirst({
        where: { id: input.id, userId: ctx.user.id },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });

      const earliestStart = new Date();
      earliestStart.setDate(earliestStart.getDate() + input.days);

      await prisma.$transaction([
        prisma.task.update({
          where: { id: task.id },
          data: {
            earliestStart,
            rescheduleCount: { increment: 1 },
            lastTouchedAt: new Date(),
          },
        }),
        prisma.scheduledBlock.deleteMany({ where: { taskId: task.id, state: 'PROPOSED' } }),
      ]);
    }),

  /**
   * Break a task into steps.
   *
   * The fallback matters as much as the AI path: someone staring at a task they
   * cannot start still gets a first step, even with no API key configured. A
   * generic "spend five minutes on it" is far more useful than an error.
   */
  breakdown: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        granularity: z.enum(['tiny', 'normal']).default('tiny'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const task = await prisma.task.findFirst({
        where: { id: input.id, userId: ctx.user.id },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });

      const setting = await prisma.aiSetting.findUnique({ where: { userId: ctx.user.id } });
      const allowed = features.ai && (setting?.allowTaskBreakdown ?? true);
      const provider = allowed ? await getAiProvider(ctx.user.id) : null;

      const genericFallback = [
        {
          title: `Spend five minutes on "${task.title}" — no goal beyond starting`,
          estimatedMinutes: 5,
          isStarterStep: true,
        },
        {
          title: 'Continue for one more block',
          estimatedMinutes: Math.max(15, task.estimateMinutes - 5),
          isStarterStep: false,
        },
      ];

      const outcome = provider
        ? await withFallback(
            () =>
              provider.breakdownTask({
                title: task.title,
                ...(task.notes ? { notes: task.notes } : {}),
                estimatedMinutes: task.estimateMinutes,
                granularity: input.granularity,
              }),
            () => genericFallback,
            { timeoutMs: 25_000, onError: (error) => console.warn('[breakdown]', error) },
          )
        : { value: genericFallback, usedAi: false };

      const subtasks = outcome.value;
      const starter = subtasks.find((subtask) => subtask.isStarterStep) ?? subtasks[0];

      await prisma.$transaction([
        prisma.task.update({
          where: { id: task.id },
          data: { starterStep: starter?.title ?? null, lastTouchedAt: new Date() },
        }),
        prisma.task.createMany({
          data: subtasks.map((subtask) => ({
            userId: ctx.user.id,
            parentId: task.id,
            projectId: task.projectId,
            title: subtask.title,
            estimateMinutes: subtask.estimatedMinutes,
            energy: subtask.isStarterStep ? ('LOW' as const) : task.energy,
            priority: task.priority,
            status: 'READY' as const,
          })),
        }),
      ]);

      return { subtasks, usedAi: outcome.usedAi };
    }),

  /**
   * Tasks that look avoided.
   *
   * Deliberately a plain query, not an AI call: the pattern is arithmetic, and
   * making it deterministic means the check-in appears identically whether or
   * not AI is configured.
   */
  avoidance: protectedProcedure.query(async ({ ctx }) => {
    const staleBefore = new Date();
    staleBefore.setDate(staleBefore.getDate() - AVOIDANCE_STALE_DAYS);

    return prisma.task.findMany({
      where: {
        userId: ctx.user.id,
        status: { notIn: ['DONE', 'CANCELLED'] },
        // Acknowledged once means we stop asking. Nagging is the failure mode.
        avoidanceAcknowledgedAt: null,
        OR: [
          { rescheduleCount: { gte: AVOIDANCE_RESCHEDULE_THRESHOLD } },
          { lastTouchedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { rescheduleCount: 'desc' },
      take: 5,
    });
  }),

  acknowledgeAvoidance: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.task.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: { avoidanceAcknowledgedAt: new Date() },
      });
    }),

  /** Record time actually spent, which is what teaches the estimation coach. */
  logTime: protectedProcedure
    .input(z.object({ id: z.string().cuid(), minutes: z.number().int().min(1).max(480) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.task.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: { actualMinutes: { increment: input.minutes }, lastTouchedAt: new Date() },
      });
    }),

  /**
   * Start a timer against this task.
   *
   * At most one task per user may be running at once — a person cannot
   * actually be doing two things simultaneously, so starting a second timer
   * implicitly means the first one just ended. Rather than reject that, this
   * stops and credits the other task's real elapsed time first, so switching
   * tasks stays a one-tap action instead of "stop, then start".
   */
  startTimer: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const task = await tx.task.findFirst({ where: { id: input.id, userId: ctx.user.id } });
        if (!task) throw new TRPCError({ code: 'NOT_FOUND' });

        const other = await tx.task.findFirst({
          where: { userId: ctx.user.id, id: { not: task.id }, timerStartedAt: { not: null } },
        });
        if (other) await creditElapsed(tx, other, now);

        await tx.task.update({
          where: { id: task.id },
          data: { timerStartedAt: now, lastTouchedAt: now },
        });

        return { startedAt: now, switchedFrom: other?.title ?? null };
      });
    }),

  /** Stop the timer and credit the real elapsed time — never a flat guess. */
  stopTimer: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const task = await tx.task.findFirst({ where: { id: input.id, userId: ctx.user.id } });
        if (!task) throw new TRPCError({ code: 'NOT_FOUND' });
        if (!task.timerStartedAt) return { minutes: 0 };

        const minutes = await creditElapsed(tx, task, now);
        return { minutes };
      });
    }),
});

/**
 * Stop whatever timer a task has running and credit its real elapsed
 * duration. Shared by `startTimer` (stopping whichever other task was
 * running) and `stopTimer` (stopping this one) so the crediting logic exists
 * exactly once.
 */
async function creditElapsed(tx: Db, task: Task, now: Date): Promise<number> {
  const startedAt = task.timerStartedAt;
  if (!startedAt) return 0;

  // Rounds up to a minute rather than down to zero — a 40-second dash to
  // start something should still count as having happened.
  const minutes = Math.max(1, Math.round((now.getTime() - startedAt.getTime()) / 60_000));

  await tx.task.update({
    where: { id: task.id },
    data: { timerStartedAt: null, actualMinutes: { increment: minutes }, lastTouchedAt: now },
  });

  return minutes;
}

/** Local copy of the categoriser, kept off the AI path so it always runs. */
function categoryFor(title: string): string {
  const lower = title.toLowerCase();
  if (/\b(email|reply|respond|message|call)\b/.test(lower)) return 'communication';
  if (/\b(write|draft|report|document|notes?)\b/.test(lower)) return 'writing';
  if (/\b(review|read|check)\b/.test(lower)) return 'review';
  if (/\b(plan|organi[sz]e|prep)\b/.test(lower)) return 'planning';
  if (/\b(code|build|fix|debug|deploy)\b/.test(lower)) return 'development';
  return 'general';
}
