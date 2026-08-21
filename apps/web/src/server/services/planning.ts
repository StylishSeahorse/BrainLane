/**
 * The bridge between stored rows and the pure scheduler.
 *
 * `@fluid/core` deliberately knows nothing about Prisma — it is a function over
 * plain data. This module is the seam: it loads a user's world, runs the
 * scheduler (optionally with an AI ordering hint), diffs the result against
 * what is currently in force, and persists it as a proposal the user can
 * accept or reject.
 *
 * Nothing here writes to a calendar. A proposal produces `PROPOSED` blocks and
 * a diff; only acceptance creates the calendar events, via the outbox.
 */
import 'server-only';
import {
  diffPlans,
  plan as runScheduler,
  startOfLocalDay,
  summarizeChanges,
  type PlannedBlock,
  type SchedulableTask,
  type SchedulingInput,
} from '@fluid/core';
import { prisma, type PlanChangeKind, type Prisma } from '@fluid/db';
import { applyAiOrderingHint, consentFrom } from './ai-scheduler';

/** How far ahead to plan. Two weeks is enough to show a deadline runway. */
const HORIZON_DAYS = 14;

export interface PlanResult {
  planVersionId: string;
  summary: string;
  usedAi: boolean;
  changes: Array<{
    kind: PlanChangeKind;
    taskId: string;
    taskTitle: string;
    reason: string;
    newStartsAt: Date | null;
    newEndsAt: Date | null;
  }>;
  unscheduled: Array<{ taskId: string; taskTitle: string; explanation: string }>;
  /** Committed work that did not fit the day it was promised to. */
  spilled: Array<{ taskId: string; taskTitle: string; explanation: string }>;
  stats: { availableMinutes: number; scheduledMinutes: number };
}

/**
 * Build a plan and store it as a proposal.
 *
 * `trigger` is carried into the diff copy so the user is told *why* their
 * schedule moved, not merely that it did.
 */
export async function buildPlan(userId: string, trigger: string): Promise<PlanResult> {
  const now = new Date();

  const [user, tasks, workingHours, energyWindows, protectedTimes, busyEvents, activeBlocks] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: { preferences: true, aiSetting: true },
      }),
      prisma.task.findMany({
        where: { userId, status: { in: ['READY', 'IN_PROGRESS'] }, completedAt: null },
        include: { blockedBy: true },
      }),
      prisma.workingHours.findMany({ where: { userId } }),
      prisma.energyWindow.findMany({ where: { userId } }),
      prisma.protectedTime.findMany({ where: { userId } }),
      prisma.event.findMany({
        where: {
          calendar: { userId, isSelected: true },
          deletedAt: null,
          status: { not: 'CANCELLED' },
          transparency: 'BUSY',
          origin: 'EXTERNAL',
          endsAt: { gt: now },
        },
      }),
      prisma.scheduledBlock.findMany({
        where: {
          task: { userId },
          state: { in: ['PROPOSED', 'ACCEPTED'] },
          endsAt: { gt: now },
        },
      }),
    ]);

  const titles = new Map(tasks.map((task) => [task.id, task.title]));

  const schedulable: SchedulableTask[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    // Net of work already done, so a half-finished task is not re-planned whole.
    remainingMinutes: Math.max(5, task.estimateMinutes - task.actualMinutes),
    priority: task.priority,
    energy: task.energy,
    ...(task.deadline ? { deadline: task.deadline } : {}),
    ...(task.earliestStart ? { earliestStart: task.earliestStart } : {}),
    isSplittable: task.isSplittable,
    minChunkMinutes: task.minChunkMinutes,
    maxChunkMinutes: task.maxChunkMinutes,
    dependsOn: task.blockedBy.map((dependency) => dependency.prerequisiteId),
    // A day the user put this on becomes a scheduling window. Expanded here
    // rather than stored as an interval because the day's boundaries depend on
    // the user's timezone, and a DST day is not 24 hours long.
    ...(task.plannedFor
      ? {
          committedTo: {
            start: startOfLocalDay(task.plannedFor, user.timeZone),
            end: startOfLocalDay(task.plannedFor, user.timeZone, 1),
          },
        }
      : {}),
  }));

  const previous: PlannedBlock[] = activeBlocks
    .filter((block) => !block.isPinned)
    .map((block, index) => ({
      taskId: block.taskId,
      start: block.startsAt,
      end: block.endsAt,
      isPinned: false,
      chunkIndex: index + 1,
      chunkCount: 1,
    }));

  const input: SchedulingInput = {
    now,
    timeZone: user.timeZone,
    horizonDays: HORIZON_DAYS,
    tasks: schedulable,
    busy: busyEvents.map((event) => ({ start: event.startsAt, end: event.endsAt })),
    // A pinned block is a decision the user already made. The scheduler
    // routes around it rather than reconsidering it.
    pinned: activeBlocks
      .filter((block) => block.isPinned)
      .map((block) => ({
        taskId: block.taskId,
        blockId: block.id,
        start: block.startsAt,
        end: block.endsAt,
      })),
    workingHours,
    energyWindows,
    protectedTimes,
    preferences: {
      bufferMinutes: user.preferences?.bufferMinutes ?? 10,
      slotGranularityMinutes: 15,
    },
    previous,
  };

  // --- AI ordering hint, if allowed and available ---------------------------
  const ordering = await applyAiOrderingHint({
    userId,
    now,
    timeZone: user.timeZone,
    workingHoursCount: workingHours.length,
    tasks: schedulable,
    rawTasks: tasks,
    consent: consentFrom(user.aiSetting),
  });

  // --- The deterministic engine decides, always -----------------------------
  const result = runScheduler({ ...input, tasks: ordering.tasks });

  const changes = diffPlans(previous, result.blocks, {
    timeZone: user.timeZone,
    now,
    taskTitles: titles,
    trigger,
  });

  // --- Persist as a proposal ------------------------------------------------
  const planVersion = await prisma.$transaction(async (tx) => {
    // Anything still awaiting a decision is superseded by this run.
    await tx.planVersion.updateMany({
      where: { userId, status: 'PROPOSED' },
      data: { status: 'SUPERSEDED', respondedAt: now },
    });

    const created = await tx.planVersion.create({
      data: {
        userId,
        trigger,
        usedAi: ordering.usedAi,
        status: 'PROPOSED',
        changes: {
          create: changes.map((change) => ({
            kind: change.kind,
            taskId: change.taskId,
            previousStartsAt: change.previous?.start ?? null,
            previousEndsAt: change.previous?.end ?? null,
            newStartsAt: change.next?.start ?? null,
            newEndsAt: change.next?.end ?? null,
            reason: change.reason,
          })),
        },
      },
    });

    // Replace only un-pinned proposals; accepted and pinned blocks stand.
    await tx.scheduledBlock.deleteMany({
      where: { task: { userId }, state: 'PROPOSED', isPinned: false },
    });

    const blocksToCreate: Prisma.ScheduledBlockCreateManyInput[] = result.blocks
      .filter((block) => !block.isPinned)
      .map((block) => ({
        taskId: block.taskId,
        startsAt: block.start,
        endsAt: block.end,
        state: 'PROPOSED' as const,
        planVersionId: created.id,
      }));

    if (blocksToCreate.length > 0) {
      await tx.scheduledBlock.createMany({ data: blocksToCreate });
    }

    return created;
  });

  return {
    planVersionId: planVersion.id,
    summary: summarizeChanges(changes, trigger),
    usedAi: ordering.usedAi,
    changes: changes
      .filter((change) => change.kind !== 'UNCHANGED')
      .map((change) => ({
        kind: change.kind,
        taskId: change.taskId,
        taskTitle: titles.get(change.taskId) ?? 'Task',
        reason: change.reason,
        newStartsAt: change.next?.start ?? null,
        newEndsAt: change.next?.end ?? null,
      })),
    unscheduled: result.unscheduled.map((entry) => ({
      taskId: entry.taskId,
      taskTitle: titles.get(entry.taskId) ?? 'Task',
      explanation: entry.explanation,
    })),
    spilled: result.spilled.map((entry) => ({
      taskId: entry.taskId,
      taskTitle: titles.get(entry.taskId) ?? 'Task',
      explanation: entry.explanation,
    })),
    stats: {
      availableMinutes: result.stats.availableMinutes,
      scheduledMinutes: result.stats.scheduledMinutes,
    },
  };
}

/**
 * Accept a proposal: its blocks become real commitments.
 *
 * The proposal is a *complete* schedule, not a patch — the stability pass
 * re-emits every block it decided to keep, so the new version already contains
 * everything that should be in force. The previously accepted blocks therefore
 * have to be retired here, or each replan-and-accept cycle leaves its
 * predecessor's blocks behind and the same work accumulates a duplicate
 * session per cycle: double-counted capacity, a doubled timeline, and two
 * calendar events for one piece of work.
 *
 * Three things are deliberately spared:
 *   - COMPLETED blocks, which are history and not part of any plan.
 *   - Pinned blocks, which the scheduler never owned and never re-emits.
 *   - This version's own blocks, which are still PROPOSED at this point.
 */
export async function acceptPlan(
  userId: string,
  planVersionId: string,
  auto = false,
): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const version = await tx.planVersion.findFirst({
      where: { id: planVersionId, userId, status: 'PROPOSED' },
    });
    if (!version) return;

    await tx.scheduledBlock.deleteMany({
      where: {
        task: { userId },
        state: 'ACCEPTED',
        isPinned: false,
        planVersionId: { not: version.id },
      },
    });

    await tx.planVersion.update({
      where: { id: version.id },
      data: {
        status: 'ACCEPTED',
        respondedAt: now,
        ...(auto ? { autoAcceptedAt: now } : {}),
      },
    });

    await tx.scheduledBlock.updateMany({
      where: { planVersionId: version.id, state: 'PROPOSED' },
      data: { state: 'ACCEPTED' },
    });
  });
}

/** Reject a proposal: its blocks are discarded, the previous plan stands. */
export async function rejectPlan(userId: string, planVersionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const version = await tx.planVersion.findFirst({
      where: { id: planVersionId, userId, status: 'PROPOSED' },
    });
    if (!version) return;

    await tx.planVersion.update({
      where: { id: version.id },
      data: { status: 'REJECTED', respondedAt: new Date() },
    });
    await tx.scheduledBlock.deleteMany({
      where: { planVersionId: version.id, state: 'PROPOSED' },
    });
  });
}
