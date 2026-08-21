import 'server-only';
import { z } from 'zod';
import { prisma, type Prisma } from '@fluid/db';
import {
  computeCapacity,
  expandProtectedTimes,
  localDayOfWeek,
  localTimeOnDay,
  parseTimeOfDay,
  startOfLocalDay,
  verdictFor,
  type Capacity,
  type Interval,
  type LoadVerdict,
} from '@fluid/core';
import { protectedProcedure, router } from '../trpc';

/**
 * The shape of a day, and the two rituals that bracket it.
 *
 * A day is treated as an object in its own right rather than a filter over
 * tasks: it has a size (how much time actually exists), a commitment (what has
 * been promised into it), and an ending. That last one matters most — without
 * a deliberate close, work has no edge, and "am I done?" becomes a question
 * nothing on screen can answer.
 */

/**
 * One working-hours row as instants on a given day, or null if unusable.
 *
 * `localTimeOnDay` rather than millisecond arithmetic from midnight: on a DST
 * boundary a day is not 24 hours long, and "09:00" has to mean nine o'clock on
 * both sides of the change.
 */
function workingWindow(day: Date, startTime: string, endTime: string, timeZone: string): Interval | null {
  let startMinutes: number;
  let endMinutes: number;
  try {
    startMinutes = parseTimeOfDay(startTime);
    endMinutes = parseTimeOfDay(endTime);
  } catch {
    return null;
  }
  // A working day that ends before it starts is a malformed row, not an
  // overnight shift. Dropping it beats reporting negative capacity.
  if (endMinutes <= startMinutes) return null;

  return {
    start: localTimeOnDay(day, startMinutes, timeZone),
    end: localTimeOnDay(day, endMinutes, timeZone),
  };
}

export interface DayShape {
  capacity: Capacity;
  verdict: LoadVerdict;
  /** True when working hours are configured but this day has none. */
  isNonWorkingDay: boolean;
  /** True when the user has no working hours at all — capacity is unknowable. */
  hasWorkingHours: boolean;
}

/**
 * Split a day's blocks into the two ledgers.
 *
 * A block with no area counts as work. That default matters: every task that
 * existed before areas did has a null area, and quietly moving all of it to
 * the personal ledger would rewrite every historical capacity figure.
 */
function partitionByLedger<T extends { task: { area: { countsTowardCapacity: boolean } | null } }>(
  blocks: T[],
): { work: T[]; personal: T[] } {
  const work: T[] = [];
  const personal: T[] = [];
  for (const block of blocks) {
    if (block.task.area && !block.task.area.countsTowardCapacity) personal.push(block);
    else work.push(block);
  }
  return { work, personal };
}

/**
 * Capacity for one local day.
 *
 * Exported rather than inlined into the procedure because the shutdown summary
 * needs exactly the same arithmetic, and two implementations of "how big is a
 * day" would drift.
 */
export async function dayShape(userId: string, day: Date, timeZone: string): Promise<DayShape> {
  const dayStart = startOfLocalDay(day, timeZone);
  const dayEnd = startOfLocalDay(day, timeZone, 1);
  const dayInterval: Interval = { start: dayStart, end: dayEnd };
  const dayOfWeek = localDayOfWeek(dayStart, timeZone);

  const [allWorkingHours, protectedTimes, blocks, events, preferences] = await Promise.all([
    prisma.workingHours.findMany({ where: { userId } }),
    prisma.protectedTime.findMany({ where: { userId } }),
    prisma.scheduledBlock.findMany({
      where: {
        task: { userId },
        state: { in: ['PROPOSED', 'ACCEPTED', 'COMPLETED'] },
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
      // The area decides which ledger a block belongs to. Selected here rather
      // than joined later so the two capacity paths cannot drift.
      select: {
        startsAt: true,
        endsAt: true,
        state: true,
        task: { select: { area: { select: { countsTowardCapacity: true } } } },
      },
    }),
    prisma.event.findMany({
      where: {
        calendar: { userId, isSelected: true },
        origin: 'EXTERNAL',
        deletedAt: null,
        status: { not: 'CANCELLED' },
        transparency: 'BUSY',
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.userPreferences.findUnique({ where: { userId } }),
  ]);

  const todaysHours = allWorkingHours.filter((row) => row.dayOfWeek === dayOfWeek);
  const workable = todaysHours.flatMap((row) => {
    const window = workingWindow(dayStart, row.startTime, row.endTime, timeZone);
    return window ? [window] : [];
  });

  const { work, personal } = partitionByLedger(blocks);

  const capacity = computeCapacity({
    day: dayInterval,
    workable,
    protectedTimes: expandProtectedTimes(
      protectedTimes.map((row) => ({
        kind: row.kind,
        dayOfWeek: row.dayOfWeek,
        startTime: row.startTime,
        endTime: row.endTime,
        start: row.startsAt,
        end: row.endsAt,
      })),
      dayInterval,
      timeZone,
    ),
    meetings: events.map((event) => ({ start: event.startsAt, end: event.endsAt })),
    // Personal time is deducted from capacity but never counted as committed
    // work — see CapacityInput.personal for why dropping it outright would
    // report free time that does not exist.
    personal: personal.map((block) => ({ start: block.startsAt, end: block.endsAt })),
    planned: work
      .filter((block) => block.state !== 'COMPLETED')
      .map((block) => ({ start: block.startsAt, end: block.endsAt })),
    completed: work
      .filter((block) => block.state === 'COMPLETED')
      .map((block) => ({ start: block.startsAt, end: block.endsAt })),
    bufferMinutes: preferences?.bufferMinutes ?? 10,
  });

  return {
    capacity,
    verdict: verdictFor(capacity),
    isNonWorkingDay: allWorkingHours.length > 0 && todaysHours.length === 0,
    hasWorkingHours: allWorkingHours.length > 0,
  };
}

/**
 * Capacity for a run of consecutive days, in one pass.
 *
 * The board needs seven of these at once. Calling `dayShape` in a loop would
 * be thirty-five queries for one screen, so the working hours, meetings and
 * blocks are loaded once across the whole range and then sliced per day. The
 * arithmetic itself is still `computeCapacity`, so the board and the day view
 * can never disagree about how full a Tuesday is.
 */
export async function weekShape(
  userId: string,
  days: Date[],
  timeZone: string,
): Promise<DayShape[]> {
  if (days.length === 0) return [];

  const rangeStart = startOfLocalDay(days[0]!, timeZone);
  const rangeEnd = startOfLocalDay(days[days.length - 1]!, timeZone, 1);

  const [allWorkingHours, protectedTimes, blocks, events, preferences] = await Promise.all([
    prisma.workingHours.findMany({ where: { userId } }),
    prisma.protectedTime.findMany({ where: { userId } }),
    prisma.scheduledBlock.findMany({
      where: {
        task: { userId },
        state: { in: ['PROPOSED', 'ACCEPTED', 'COMPLETED'] },
        startsAt: { lt: rangeEnd },
        endsAt: { gt: rangeStart },
      },
      // The area decides which ledger a block belongs to. Selected here rather
      // than joined later so the two capacity paths cannot drift.
      select: {
        startsAt: true,
        endsAt: true,
        state: true,
        task: { select: { area: { select: { countsTowardCapacity: true } } } },
      },
    }),
    prisma.event.findMany({
      where: {
        calendar: { userId, isSelected: true },
        origin: 'EXTERNAL',
        deletedAt: null,
        status: { not: 'CANCELLED' },
        transparency: 'BUSY',
        startsAt: { lt: rangeEnd },
        endsAt: { gt: rangeStart },
      },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.userPreferences.findUnique({ where: { userId } }),
  ]);

  const bufferMinutes = preferences?.bufferMinutes ?? 10;

  return days.map((day) => {
    const dayStart = startOfLocalDay(day, timeZone);
    const dayEnd = startOfLocalDay(day, timeZone, 1);
    const dayInterval: Interval = { start: dayStart, end: dayEnd };
    const dayOfWeek = localDayOfWeek(dayStart, timeZone);

    // Half-open overlap, matching the query above: an event ending exactly at
    // midnight belongs to the day it started in, not the next one.
    const overlaps = <T extends { startsAt: Date; endsAt: Date }>(rows: T[]): T[] =>
      rows.filter((row) => row.startsAt < dayEnd && row.endsAt > dayStart);

    const todaysHours = allWorkingHours.filter((row) => row.dayOfWeek === dayOfWeek);
    const workable = todaysHours.flatMap((row) => {
      const window = workingWindow(dayStart, row.startTime, row.endTime, timeZone);
      return window ? [window] : [];
    });

    const { work, personal } = partitionByLedger(overlaps(blocks));

    const capacity = computeCapacity({
      day: dayInterval,
      workable,
      protectedTimes: expandProtectedTimes(
        protectedTimes.map((row) => ({
          kind: row.kind,
          dayOfWeek: row.dayOfWeek,
          startTime: row.startTime,
          endTime: row.endTime,
          start: row.startsAt,
          end: row.endsAt,
        })),
        dayInterval,
        timeZone,
      ),
      meetings: overlaps(events).map((event) => ({ start: event.startsAt, end: event.endsAt })),
      personal: personal.map((block) => ({ start: block.startsAt, end: block.endsAt })),
      planned: work
        .filter((block) => block.state !== 'COMPLETED')
        .map((block) => ({ start: block.startsAt, end: block.endsAt })),
      completed: work
        .filter((block) => block.state === 'COMPLETED')
        .map((block) => ({ start: block.startsAt, end: block.endsAt })),
      bufferMinutes,
    });

    return {
      capacity,
      verdict: verdictFor(capacity),
      isNonWorkingDay: allWorkingHours.length > 0 && todaysHours.length === 0,
      hasWorkingHours: allWorkingHours.length > 0,
    };
  });
}

export const dayRouter = router({
  /** How big this day is, and how much of it is already spoken for. */
  shape: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .query(async ({ ctx, input }) => dayShape(ctx.user.id, input.day, ctx.user.timeZone)),

  /** The ritual state of a day: has it been planned, has it been closed. */
  log: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const day = startOfLocalDay(input.day, ctx.user.timeZone);
      return prisma.dayLog.findUnique({
        where: { userId_day: { userId: ctx.user.id, day } },
      });
    }),

  /**
   * What is still open at the end of the day.
   *
   * Only tasks that had a session booked today count as "unfinished today".
   * Everything else in the backlog was never a commitment to this day, and
   * listing it at shutdown would turn a two-minute close into an audit of the
   * entire task list.
   */
  loose: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const dayStart = startOfLocalDay(input.day, ctx.user.timeZone);
      const dayEnd = startOfLocalDay(input.day, ctx.user.timeZone, 1);

      const blocks = await prisma.scheduledBlock.findMany({
        where: {
          task: { userId: ctx.user.id, status: { notIn: ['DONE', 'CANCELLED'] } },
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
          state: { in: ['PROPOSED', 'ACCEPTED'] },
        },
        include: {
          task: {
            select: {
              id: true,
              title: true,
              estimateMinutes: true,
              actualMinutes: true,
              rescheduleCount: true,
            },
          },
        },
        orderBy: { startsAt: 'asc' },
      });

      // One row per task: a task split across three sittings is still one
      // decision to make, not three.
      const seen = new Map<string, (typeof blocks)[number]['task']>();
      for (const block of blocks) seen.set(block.task.id, block.task);
      return [...seen.values()];
    }),

  /**
   * Close the day.
   *
   * Figures are frozen into the log rather than recomputed later: a day's
   * history should not change because a task was edited next week.
   */
  shutdown: protectedProcedure
    .input(
      z.object({
        day: z.coerce.date(),
        reflection: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const day = startOfLocalDay(input.day, ctx.user.timeZone);
      const dayEnd = startOfLocalDay(input.day, ctx.user.timeZone, 1);
      const shape = await dayShape(ctx.user.id, day, ctx.user.timeZone);

      const completedCount = await prisma.task.count({
        where: { userId: ctx.user.id, status: 'DONE', completedAt: { gte: day, lt: dayEnd } },
      });

      const values = {
        shutdownAt: new Date(),
        reflection: input.reflection || null,
        completedCount,
        focusedMinutes: Math.round(shape.capacity.completedMinutes),
        meetingMinutes: Math.round(shape.capacity.meetingMinutes),
      };

      return prisma.dayLog.upsert({
        where: { userId_day: { userId: ctx.user.id, day } },
        create: { userId: ctx.user.id, day, ...values },
        update: values,
      });
    }),

  /** Undo a shutdown — the day is not over after all. */
  reopen: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const day = startOfLocalDay(input.day, ctx.user.timeZone);
      await prisma.dayLog.updateMany({
        where: { userId: ctx.user.id, day },
        data: { shutdownAt: null },
      });
    }),

  /**
   * Work committed to this day that the scheduler has not placed yet.
   *
   * The board and Today have to agree, and without this they do not: dragging
   * a card onto today puts it on the board immediately, but nothing appears on
   * the day itself until a replan runs. A commitment that is invisible on the
   * screen where the work happens is worse than no commitment — it teaches
   * people the board is decorative.
   */
  unplaced: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const dayStart = startOfLocalDay(input.day, ctx.user.timeZone);
      const dayEnd = startOfLocalDay(input.day, ctx.user.timeZone, 1);

      return prisma.task.findMany({
        where: {
          userId: ctx.user.id,
          parentId: null,
          plannedFor: dayStart,
          status: { notIn: ['DONE', 'CANCELLED'] },
          // "Unplaced" means nothing on the plan overlaps this day. A task with
          // a session tomorrow is still unplaced *today*.
          scheduledBlocks: {
            none: {
              state: { in: ['PROPOSED', 'ACCEPTED'] },
              startsAt: { lt: dayEnd },
              endsAt: { gt: dayStart },
            },
          },
        },
        select: {
          id: true,
          title: true,
          estimateMinutes: true,
          energy: true,
          priority: true,
          starterStep: true,
          timerStartedAt: true,
          rolloverCount: true,
          project: { select: { name: true, color: true } },
        },
        orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
      });
    }),

  /**
   * Everything the morning ritual needs, in one round trip.
   *
   * Composed server-side rather than assembled from six calls in the page,
   * because the ritual's whole value is that it is quick. A planning flow that
   * makes someone wait is one they abandon halfway, and a half-planned day is
   * worse than an unplanned one — it looks decided without being decided.
   */
  planning: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const timeZone = ctx.user.timeZone;
      const day = startOfLocalDay(input.day, timeZone);
      const dayEnd = startOfLocalDay(input.day, timeZone, 1);
      const previous = startOfLocalDay(input.day, timeZone, -1);

      const card = {
        id: true,
        title: true,
        estimateMinutes: true,
        priority: true,
        energy: true,
        deadline: true,
        timeBucket: true,
        rolloverCount: true,
        project: { select: { name: true, color: true } },
      } satisfies Prisma.TaskSelect;

      const [yesterday, today, backlog, meetings, shape, log] = await Promise.all([
        prisma.task.findMany({
          where: {
            userId: ctx.user.id,
            parentId: null,
            plannedFor: previous,
            status: { notIn: ['DONE', 'CANCELLED'] },
          },
          select: card,
          orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.task.findMany({
          where: {
            userId: ctx.user.id,
            parentId: null,
            plannedFor: day,
            status: { notIn: ['DONE', 'CANCELLED'] },
          },
          select: card,
          orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
        }),
        // Deadline-first, so the things that actually have to happen surface
        // before an undated pile the user would otherwise have to read past.
        prisma.task.findMany({
          where: {
            userId: ctx.user.id,
            parentId: null,
            status: { notIn: ['DONE', 'CANCELLED'] },
            archivedAt: null,
            plannedFor: null,
          },
          select: card,
          orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
          take: 40,
        }),
        prisma.event.findMany({
          where: {
            calendar: { userId: ctx.user.id, isSelected: true },
            origin: 'EXTERNAL',
            deletedAt: null,
            status: { not: 'CANCELLED' },
            transparency: 'BUSY',
            startsAt: { lt: dayEnd },
            endsAt: { gt: day },
          },
          select: { id: true, title: true, startsAt: true, endsAt: true },
          orderBy: { startsAt: 'asc' },
        }),
        dayShape(ctx.user.id, day, timeZone),
        prisma.dayLog.findUnique({
          where: { userId_day: { userId: ctx.user.id, day } },
        }),
      ]);

      const completedYesterday = await prisma.task.count({
        where: {
          userId: ctx.user.id,
          status: 'DONE',
          completedAt: { gte: previous, lt: day },
        },
      });

      return {
        day,
        yesterday,
        completedYesterday,
        today,
        backlog,
        meetings,
        shape,
        alreadyPlannedAt: log?.plannedAt ?? null,
      };
    }),

  /**
   * What actually got done, grouped and worth reading back.
   *
   * Sunsama's daily highlights. Two decisions shape it:
   *
   * Grouped by project rather than listed flat, because "four hours on the
   * quarterly report" is a day someone can recognise, while eleven task titles
   * in completion order is a log. The point of the ritual is to be able to
   * answer "what did I do today?" with something other than "I was busy".
   *
   * Built from *logged* minutes, never estimates. A highlight reel assembled
   * from what you thought things would take is fiction, and this is the one
   * screen whose whole job is to be true.
   */
  highlights: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const day = startOfLocalDay(input.day, ctx.user.timeZone);
      const dayEnd = startOfLocalDay(input.day, ctx.user.timeZone, 1);

      const done = await prisma.task.findMany({
        where: {
          userId: ctx.user.id,
          status: 'DONE',
          completedAt: { gte: day, lt: dayEnd },
        },
        select: {
          id: true,
          title: true,
          actualMinutes: true,
          estimateMinutes: true,
          project: { select: { id: true, name: true, color: true } },
          area: { select: { id: true, name: true, color: true, countsTowardCapacity: true } },
        },
        orderBy: { completedAt: 'asc' },
      });

      interface Group {
        key: string;
        name: string;
        color: string | null;
        minutes: number;
        /** False for groups whose area sits outside the work ledger. */
        counts: boolean;
        items: Array<{ id: string; title: string; minutes: number }>;
      }

      const groups = new Map<string, Group>();
      for (const task of done) {
        const counts = task.area?.countsTowardCapacity ?? true;
        // The ledger is part of the key, not just a label on the group. An
        // "Admin" project holding both a client invoice and a dentist
        // appointment must not report the appointment as work delivered —
        // that is the same split the capacity meter makes, and the two
        // screens disagreeing is worse than either being slightly coarse.
        const key = `${task.project?.id ?? task.area?.id ?? 'other'}:${counts}`;
        const group = groups.get(key) ?? {
          key,
          name: task.project?.name ?? task.area?.name ?? 'Everything else',
          color: task.area?.color ?? task.project?.color ?? null,
          minutes: 0,
          counts,
          items: [],
        };
        // Fall back to the estimate only when nothing was ever timed, so a
        // task finished without the timer still appears rather than reading
        // as zero minutes of work.
        const minutes = task.actualMinutes > 0 ? task.actualMinutes : task.estimateMinutes;
        group.minutes += minutes;
        group.items.push({ id: task.id, title: task.title, minutes });
        groups.set(key, group);
      }

      const ordered = [...groups.values()].sort((a, b) => b.minutes - a.minutes);

      return {
        groups: ordered,
        totalMinutes: ordered.reduce((sum, group) => sum + group.minutes, 0),
        taskCount: done.length,
      };
    }),

  /** Mark the morning plan as done, so the prompt stops asking. */
  markPlanned: protectedProcedure
    .input(z.object({ day: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const day = startOfLocalDay(input.day, ctx.user.timeZone);
      await prisma.dayLog.upsert({
        where: { userId_day: { userId: ctx.user.id, day } },
        create: { userId: ctx.user.id, day, plannedAt: new Date() },
        update: { plannedAt: new Date() },
      });
    }),
});
