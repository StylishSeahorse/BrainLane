/**
 * The deterministic scheduler.
 *
 * This is the primary engine, not a fallback. The AI proposes; this decides.
 * Two consequences follow from that ordering, and both are deliberate:
 *
 *   - The app keeps working when the AI is slow, down, disabled, or when the
 *     user has opted out of AI entirely.
 *   - An AI proposal is validated by this engine before it can be applied, so a
 *     prompt injected through a calendar invite cannot produce a schedule that
 *     violates protected time or double-books a meeting. The worst it can do is
 *     suggest something the user sees in the diff and rejects.
 *
 * Constraints, in strict priority order:
 *   1. Protected time is inviolable — including live hyperfocus.
 *   2. Never overlap existing busy time.
 *   3. Stay inside working hours.
 *   4. Respect dependencies and earliest-start dates.
 *   5. Meet deadlines (earliest-deadline-first).
 *   6. Match task energy to the slot's energy.
 *   7. Respect chunk sizes and buffers.
 *   8. Minimize churn against the plan already in force.
 *
 * Rule 8 is last in precedence but does the most for the user. A schedule that
 * reshuffles wholesale on every replan stops functioning as external structure,
 * which for someone relying on it to counter time blindness is the entire value
 * of the product.
 */
import { addMinutes, minutesBetween, startOfLocalDay } from '../time/zoned';
import {
  buildAvailability,
  buildEnergyMap,
  energyAt,
  energySatisfies,
  type EnergyMap,
} from './availability';
import { alignUp, contains, durationMinutes, subtractIntervals, totalMinutes } from './intervals';
import type {
  Interval,
  Plan,
  PlannedBlock,
  Priority,
  SchedulableTask,
  SchedulingInput,
  SpilledCommitment,
  UnscheduledReason,
  UnscheduledTask,
} from './types';

const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };

/** Far enough out to sort after any real deadline, without using Infinity. */
const NO_DEADLINE_SLACK = 365 * 24 * 60;

// ---------------------------------------------------------------------------
// Dependency ordering
// ---------------------------------------------------------------------------

interface OrderedTasks {
  ordered: SchedulableTask[];
  /** Tasks in a dependency cycle. Reported, never silently dropped. */
  cyclic: SchedulableTask[];
}

/**
 * Topological sort, with ties broken by urgency.
 *
 * Kahn's algorithm: repeatedly take tasks whose prerequisites are all placed.
 * Anything still left when nothing is ready is in a cycle.
 */
function orderTasks(tasks: SchedulableTask[], now: Date): OrderedTasks {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remaining = new Set(tasks.map((task) => task.id));
  const ordered: SchedulableTask[] = [];

  const urgency = (task: SchedulableTask): number => {
    // Slack: how much spare time exists between now and the deadline once the
    // work itself is accounted for. Less slack is more urgent — this is what
    // makes a small task due tomorrow outrank a large one due next month.
    const slack = task.deadline
      ? minutesBetween(now, task.deadline) - task.remainingMinutes
      : NO_DEADLINE_SLACK;
    return slack;
  };

  /**
   * Which day the user promised this to. Uncommitted work sorts last.
   *
   * This outranks priority on purpose. Priority is the scheduler's opinion
   * about what matters; a day commitment is the user's decision about what
   * they are actually doing, and the second should win. It costs uncommitted
   * work very little in practice, because a task committed to Friday can only
   * be placed on Friday anyway — the two rarely compete for the same slot.
   */
  const commitment = (task: SchedulableTask): number =>
    task.committedTo ? task.committedTo.start.getTime() : Number.MAX_SAFE_INTEGER;

  const compare = (a: SchedulableTask, b: SchedulableTask): number =>
    commitment(a) - commitment(b) ||
    PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
    urgency(a) - urgency(b) ||
    a.id.localeCompare(b.id); // Deterministic tie-break: identical inputs must
  // always produce an identical plan, or the diff is noise.

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((task) =>
        (task.dependsOn ?? []).every((depId) => !remaining.has(depId) || !byId.has(depId)),
      );

    if (ready.length === 0) break; // Everything left depends on something left.

    ready.sort(compare);
    for (const task of ready) {
      ordered.push(task);
      remaining.delete(task.id);
    }
  }

  return {
    ordered,
    cyclic: [...remaining].map((id) => byId.get(id)!),
  };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split a task's remaining work into sittings.
 *
 * Chunks are made as even as possible rather than greedily filling to the
 * maximum. Greedy filling leaves a stub at the end — a 15-minute fragment of a
 * task is the kind of block that gets skipped, and a skipped block feeds the
 * avoidance spiral this product exists to interrupt.
 */
export function chunkTask(task: SchedulableTask): number[] {
  const total = task.remainingMinutes;
  if (total <= 0) return [];

  if (!task.isSplittable || total <= task.maxChunkMinutes) return [total];

  const chunkCount = Math.ceil(total / task.maxChunkMinutes);
  const base = Math.floor(total / chunkCount);
  const remainder = total % chunkCount;

  const chunks = Array.from({ length: chunkCount }, (_, index) =>
    index < remainder ? base + 1 : base,
  );

  // If evening things out pushed chunks below the useful minimum, fall back to
  // fewer, larger sittings. Better one 40-minute block than two 20s that never
  // get started.
  if (chunks.some((size) => size < task.minChunkMinutes)) {
    const viableCount = Math.max(1, Math.floor(total / task.minChunkMinutes));
    const cappedCount = Math.min(viableCount, chunkCount);
    const evenBase = Math.floor(total / cappedCount);
    const evenRemainder = total % cappedCount;
    return Array.from({ length: cappedCount }, (_, index) =>
      index < evenRemainder ? evenBase + 1 : evenBase,
    );
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface PlacementContext {
  free: Interval[];
  energy: EnergyMap;
  bufferMinutes: number;
  granularity: number;
  dayAnchor: Date;
}

interface Placement {
  interval: Interval;
  energyMatched: boolean;
}

/**
 * Find the earliest slot that fits `minutes` of work.
 *
 * Two passes: first insisting on an energy match, then relaxing it. Placing
 * demanding work into a slot the user has told us is low-focus wastes the slot
 * and teaches them the schedule is not worth following — but leaving the task
 * entirely unscheduled is worse.
 */
function findSlot(
  context: PlacementContext,
  minutes: number,
  notBefore: Date,
  requiredEnergy: SchedulableTask['energy'],
  notAfter?: Date,
  within?: Interval,
): Placement | null {
  // A commitment window narrows both ends. Intersecting here rather than
  // filtering afterwards means the energy-relaxation passes below still get to
  // do their job inside the chosen day.
  let floor = notBefore;
  let ceiling = notAfter;
  if (within) {
    if (within.start > floor) floor = within.start;
    if (!ceiling || within.end < ceiling) ceiling = within.end;
    if (floor >= ceiling) return null;
  }

  for (const insistOnEnergy of [true, false]) {
    for (const slot of context.free) {
      if (slot.end <= floor) continue;

      const earliest = slot.start < floor ? floor : slot.start;
      const start = alignUp(earliest, context.granularity, context.dayAnchor);
      const end = addMinutes(start, minutes);

      // The buffer must fit inside the free slot too, otherwise the next block
      // starts immediately after this one with no breathing room.
      if (addMinutes(end, context.bufferMinutes) > slot.end && end > slot.end) continue;
      if (end > slot.end) continue;
      if (ceiling && end > ceiling) continue;

      const matched = energySatisfies(energyAt(context.energy, start), requiredEnergy);
      if (insistOnEnergy && !matched) continue;

      return { interval: { start, end }, energyMatched: matched };
    }
  }

  return null;
}

/** Remove a placed block, plus its trailing buffer, from remaining free time. */
function consume(context: PlacementContext, placed: Interval): void {
  context.free = subtractIntervals(context.free, [
    { start: placed.start, end: addMinutes(placed.end, context.bufferMinutes) },
  ]);
}

/** Is this exact interval still entirely unoccupied? */
function isStillFree(free: Interval[], candidate: Interval): boolean {
  return free.some((slot) => contains(slot, candidate));
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

export function plan(input: SchedulingInput): Plan {
  const { now, timeZone, preferences } = input;

  const availability = buildAvailability({
    now,
    timeZone,
    horizonDays: input.horizonDays,
    workingHours: input.workingHours,
    protectedTimes: input.protectedTimes,
    // Pinned blocks occupy time exactly like an external meeting does.
    busy: [...input.busy, ...input.pinned.map((p) => ({ start: p.start, end: p.end }))],
  });

  const energy = buildEnergyMap(input.energyWindows, availability.bounds, timeZone);

  const context: PlacementContext = {
    free: availability.free,
    energy,
    bufferMinutes: Math.max(0, preferences.bufferMinutes),
    granularity: Math.max(1, preferences.slotGranularityMinutes),
    dayAnchor: startOfLocalDay(now, timeZone),
  };

  const blocks: PlannedBlock[] = [];
  const unscheduled: UnscheduledTask[] = [];
  const spilled: SpilledCommitment[] = [];

  // Pinned blocks are decisions the user already made. They enter the plan
  // untouched and their time is already excluded from `free`.
  for (const pinnedBlock of input.pinned) {
    blocks.push({
      taskId: pinnedBlock.taskId,
      start: pinnedBlock.start,
      end: pinnedBlock.end,
      isPinned: true,
      chunkIndex: 1,
      chunkCount: 1,
    });
  }

  const byId = new Map(input.tasks.map((task) => [task.id, task]));

  // ---------------------------------------------------------------------
  // Stability pass.
  //
  // Before placing anything new, keep whatever the current plan already has in
  // place — provided the slot is still free and still legal. Only the time that
  // genuinely has to move gets re-planned.
  //
  // This runs first, and greedily, because a block the user has already seen,
  // mentally committed to, and possibly told someone else about is worth more
  // than a marginally better arrangement. For a user leaning on this schedule
  // as external structure, a plan that churns is worse than a plan that is
  // slightly suboptimal.
  // ---------------------------------------------------------------------
  const retained = new Map<string, Interval[]>();

  if (input.previous?.length) {
    const previousByStart = [...input.previous].sort(
      (a, b) => a.start.getTime() - b.start.getTime(),
    );

    for (const previousBlock of previousByStart) {
      const task = byId.get(previousBlock.taskId);
      if (!task) continue; // Task completed or deleted since the last plan.
      if (previousBlock.end <= now) continue; // Already in the past.
      if (task.earliestStart && previousBlock.start < task.earliestStart) continue;

      const candidate: Interval = { start: previousBlock.start, end: previousBlock.end };

      // Stability yields to an explicit day commitment. Without this, dragging
      // a task onto another day would be silently undone by the next replan:
      // the old block is still legal and still free, so the churn-minimizing
      // pass would keep it exactly where the user just moved it from.
      if (task.committedTo && !contains(task.committedTo, candidate)) continue;

      if (!isStillFree(context.free, candidate)) continue; // Something else took it.

      // Do not retain more time than the task still needs — it may have shrunk.
      const alreadyRetained = totalMinutes(retained.get(task.id) ?? []);
      if (alreadyRetained + durationMinutes(candidate) > task.remainingMinutes) continue;

      consume(context, candidate);
      retained.set(task.id, [...(retained.get(task.id) ?? []), candidate]);
    }
  }

  const { ordered, cyclic } = orderTasks(input.tasks, now);

  for (const task of cyclic) {
    unscheduled.push({
      taskId: task.id,
      reason: 'DEPENDENCY_CYCLE',
      explanation:
        `"${task.title}" is part of a loop of tasks that each wait on the other, ` +
        `so none of them can start. Removing one link will free the rest.`,
      shortfallMinutes: task.remainingMinutes,
    });
  }

  /** When each task finishes, so dependents can be placed after it. */
  const finishedAt = new Map<string, Date>();
  for (const pinnedBlock of input.pinned) {
    const existing = finishedAt.get(pinnedBlock.taskId);
    if (!existing || pinnedBlock.end > existing) finishedAt.set(pinnedBlock.taskId, pinnedBlock.end);
  }

  for (const task of ordered) {
    const retainedIntervals = retained.get(task.id) ?? [];
    const retainedMinutes = totalMinutes(retainedIntervals);
    const outstandingMinutes = task.remainingMinutes - retainedMinutes;

    // Chunk only the work the stability pass did not already cover.
    const chunks =
      outstandingMinutes > 0 ? chunkTask({ ...task, remainingMinutes: outstandingMinutes }) : [];

    if (chunks.length === 0 && retainedIntervals.length === 0) continue;

    // Earliest this task may begin: now, its own earliest-start, and after
    // everything it depends on has finished.
    let notBefore = now;
    if (task.earliestStart && task.earliestStart > notBefore) notBefore = task.earliestStart;

    let blockedByUnplaced: string | null = null;
    for (const depId of task.dependsOn ?? []) {
      const depFinish = finishedAt.get(depId);
      if (!depFinish) {
        // The prerequisite itself could not be scheduled.
        if (input.tasks.some((candidate) => candidate.id === depId)) blockedByUnplaced = depId;
        continue;
      }
      if (depFinish > notBefore) notBefore = depFinish;
    }

    if (blockedByUnplaced) {
      const blocker = input.tasks.find((candidate) => candidate.id === blockedByUnplaced);
      unscheduled.push({
        taskId: task.id,
        reason: 'BLOCKED_BY_DEPENDENCY',
        explanation:
          `"${task.title}" is waiting on "${blocker?.title ?? blockedByUnplaced}", ` +
          `which could not be fitted in yet.`,
        shortfallMinutes: task.remainingMinutes,
      });
      continue;
    }

    if (notBefore >= availability.bounds.end) {
      unscheduled.push({
        taskId: task.id,
        reason: 'STARTS_AFTER_HORIZON',
        explanation:
          `"${task.title}" cannot start until after the end of the planning window, ` +
          `so there is nothing to schedule yet.`,
        shortfallMinutes: task.remainingMinutes,
      });
      continue;
    }

    // Retained blocks count as already placed.
    let placedMinutes = retainedMinutes;
    let missedDeadline = false;
    let spilledMinutes = 0;
    const placedChunks: Interval[] = [...retainedIntervals];

    // Continue after whatever the stability pass kept, so a task's sessions
    // stay in order.
    const lastRetainedEnd = retainedIntervals.at(-1)?.end;
    let cursor = lastRetainedEnd && lastRetainedEnd > notBefore ? lastRetainedEnd : notBefore;

    for (const chunkMinutes of chunks) {
      // Three relaxations, in order of what the user loses by giving it up:
      // the day they picked, then the deadline. Energy is relaxed inside
      // findSlot, before either.
      let placement: ReturnType<typeof findSlot> = null;

      if (task.committedTo) {
        placement = findSlot(
          context,
          chunkMinutes,
          cursor,
          task.energy,
          task.deadline,
          task.committedTo,
        );
      }
      // Only counts as spill once the work has actually landed somewhere else.
      // A chunk that finds no home at all is unscheduled, which is a different
      // thing to say and is reported below.
      const leftItsDay = task.committedTo !== undefined && placement === null;

      // Prefer to land the whole task before its deadline; if that is
      // impossible, still schedule the work and say so. Refusing to schedule a
      // late task helps nobody — the work does not stop existing.
      if (!placement) {
        placement = findSlot(context, chunkMinutes, cursor, task.energy, task.deadline);
      }
      if (!placement && task.deadline) {
        placement = findSlot(context, chunkMinutes, cursor, task.energy);
        if (placement) missedDeadline = true;
      }

      if (!placement) break;
      if (leftItsDay) spilledMinutes += chunkMinutes;

      consume(context, placement.interval);
      placedChunks.push(placement.interval);
      placedMinutes += chunkMinutes;
      cursor = placement.interval.end;
    }

    // Retained and newly placed chunks are merged, so "session 1 of 3" numbers
    // in chronological order regardless of which pass produced them.
    placedChunks.sort((a, b) => a.start.getTime() - b.start.getTime());
    placedChunks.forEach((interval, index) => {
      blocks.push({
        taskId: task.id,
        start: interval.start,
        end: interval.end,
        isPinned: false,
        chunkIndex: index + 1,
        chunkCount: placedChunks.length,
      });
    });

    if (placedChunks.length > 0) {
      finishedAt.set(task.id, placedChunks[placedChunks.length - 1]!.end);
    }

    const shortfall = task.remainingMinutes - placedMinutes;
    if (shortfall > 0) {
      const reason: UnscheduledReason = missedDeadline
        ? 'DEADLINE_UNREACHABLE'
        : 'NO_AVAILABLE_TIME';
      unscheduled.push({
        taskId: task.id,
        reason,
        explanation:
          placedMinutes === 0
            ? `There is no free time left in your working hours for "${task.title}".`
            : `Only ${placedMinutes} of ${task.remainingMinutes} minutes of "${task.title}" ` +
              `would fit. ${shortfall} minutes still need a home.`,
        shortfallMinutes: shortfall,
      });
    } else if (missedDeadline) {
      unscheduled.push({
        taskId: task.id,
        reason: 'DEADLINE_UNREACHABLE',
        explanation:
          `"${task.title}" is scheduled, but the last session lands after its deadline. ` +
          `Something needs to give: a later deadline, a smaller scope, or moving something else.`,
        shortfallMinutes: 0,
      });
    }

    if (spilledMinutes > 0 && task.committedTo) {
      spilled.push({
        taskId: task.id,
        committedTo: task.committedTo,
        spilledMinutes,
        explanation:
          `That day was already full, so ${spilledMinutes} minutes of "${task.title}" ` +
          `moved to the next opening. Nothing was dropped.`,
      });
    }
  }

  blocks.sort((a, b) => a.start.getTime() - b.start.getTime() || a.taskId.localeCompare(b.taskId));

  return {
    blocks,
    unscheduled,
    spilled,
    changes: [],
    stats: {
      availableMinutes: totalMinutes(availability.free),
      scheduledMinutes: blocks.reduce((sum, block) => sum + durationMinutes(block), 0),
      tasksScheduled: new Set(blocks.map((block) => block.taskId)).size,
      tasksUnscheduled: new Set(unscheduled.map((entry) => entry.taskId)).size,
    },
  };
}
