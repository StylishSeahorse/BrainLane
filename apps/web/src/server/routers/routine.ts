import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma, type ProtectedTime } from '@fluid/db';
import { protectedProcedure, router } from '../trpc';

/**
 * Recurring routine blocks — brush teeth, lunch, the commute — the kind of
 * fixed life a scheduler has to route around rather than plan over.
 *
 * These are `ProtectedTime` rows with `kind: 'ROUTINE'`. The scheduler
 * already treats protected time as inviolable (`@fluid/core`'s
 * `expandProtectedTimes`, consulted by both the deterministic planner and the
 * AI action validator), so a routine created here is enforced for free —
 * this router only populates a table the scheduler already respects, rather
 * than teaching it something new.
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const routineInput = z.object({
  label: z.string().trim().min(1, 'Give it a name.').max(60),
  startTime: z.string().regex(TIME, 'Use HH:MM.'),
  endTime: z.string().regex(TIME, 'Use HH:MM.'),
  /** 0 = Sunday .. 6 = Saturday. Empty or omitted means every day. */
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
});

export interface RoutineSummary {
  groupId: string;
  label: string;
  startTime: string;
  endTime: string;
  /** null means every day. */
  days: number[] | null;
}

/**
 * Fold the rows one multi-day pick produced back into a single entry.
 *
 * `dayOfWeek` only ever holds one day, so "weekdays" is five rows underneath
 * — genuinely necessary for the scheduler, which reasons about one calendar
 * day at a time, but not something a person should have to see or delete
 * five times over.
 */
function groupRows(rows: ProtectedTime[]): RoutineSummary[] {
  const groups = new Map<string, ProtectedTime[]>();

  for (const row of rows) {
    const key = row.groupId ?? row.id;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0]!;
    return {
      groupId: key,
      label: first.label ?? 'Routine',
      startTime: first.startTime ?? '00:00',
      endTime: first.endTime ?? '00:00',
      days: group.some((row) => row.dayOfWeek === null)
        ? null
        : [...new Set(group.map((row) => row.dayOfWeek!))].sort((a, b) => a - b),
    };
  });
}

export const routineRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await prisma.protectedTime.findMany({
      where: { userId: ctx.user.id, kind: 'ROUTINE' },
      orderBy: [{ startTime: 'asc' }],
    });
    return groupRows(rows);
  }),

  create: protectedProcedure.input(routineInput).mutation(async ({ ctx, input }) => {
    if (input.startTime === input.endTime) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'That would be zero minutes long.' });
    }

    const days = input.days && input.days.length > 0 ? [...new Set(input.days)] : null;
    const dayList: Array<number | null> = days ?? [null];
    // Only a genuinely multi-row routine needs a group to be reassembled by —
    // a single day (or "every day", which is one row) has nothing to group.
    const groupId = dayList.length > 1 ? crypto.randomUUID() : null;

    await prisma.protectedTime.createMany({
      data: dayList.map((dayOfWeek) => ({
        userId: ctx.user.id,
        kind: 'ROUTINE' as const,
        label: input.label,
        startTime: input.startTime,
        endTime: input.endTime,
        dayOfWeek,
        groupId,
      })),
    });
  }),

  /** Deletes every row in the group — the whole routine, not one of its days. */
  delete: protectedProcedure
    .input(z.object({ groupId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.protectedTime.deleteMany({
        where: {
          userId: ctx.user.id,
          kind: 'ROUTINE',
          OR: [{ groupId: input.groupId }, { id: input.groupId }],
        },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),
});
