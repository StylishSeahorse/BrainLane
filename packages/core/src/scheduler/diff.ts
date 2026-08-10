/**
 * Plan diffing.
 *
 * The brief's rule is that nothing changes silently. This module turns two
 * plans into the sentences a person actually reads before accepting a change.
 *
 * The tone rules are product requirements, not decoration:
 *   - Say what moved and what caused it. "Moved to Thursday 10am because a
 *     meeting landed on your Wednesday block" — never "constraint 2 violated".
 *   - Never imply fault. The user did not fail by having a meeting appear, and
 *     a tool that reads as disappointed gets closed and not reopened.
 *   - Lead with the fact, not the apology.
 */
import { minutesBetween, toLocal } from '../time/zoned';
import { durationMinutes } from './intervals';
import type { Interval, PlanChange, PlannedBlock } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Thursday 10:00", or "today at 10:00" when it is today. */
export function describeMoment(instant: Date, timeZone: string, relativeTo: Date): string {
  const local = toLocal(instant, timeZone);
  const reference = toLocal(relativeTo, timeZone);

  const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const sameDay =
    local.year === reference.year && local.month === reference.month && local.day === reference.day;

  if (sameDay) return `today at ${time}`;

  const dayOfWeek = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const daysAhead = Math.round(
    (Date.UTC(local.year, local.month - 1, local.day) -
      Date.UTC(reference.year, reference.month - 1, reference.day)) /
      86_400_000,
  );

  if (daysAhead === 1) return `tomorrow at ${time}`;
  if (daysAhead > 1 && daysAhead < 7) return `${WEEKDAYS[dayOfWeek]} at ${time}`;

  return `${WEEKDAYS[dayOfWeek]} ${local.day}/${local.month} at ${time}`;
}

function describeDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;

  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

export interface DiffContext {
  timeZone: string;
  now: Date;
  /** Task id -> display title, for readable sentences. */
  taskTitles: Map<string, string>;
  /**
   * Why the replan happened at all. Shown once at the top of the diff, and used
   * to explain individual moves.
   */
  trigger: string;
}

/** Human-readable cause, from the machine trigger name. */
export function describeTrigger(trigger: string): string {
  switch (trigger) {
    case 'external_event_conflict':
      return 'a new event appeared on your calendar';
    case 'task_skipped':
      return 'a session was skipped';
    case 'task_overran':
      return 'a session ran longer than planned';
    case 'new_urgent_task':
      return 'an urgent task was added';
    case 'task_completed':
      return 'a task was finished early';
    case 'settings_changed':
      return 'your working hours or preferences changed';
    case 'manual':
      return 'you asked for a fresh plan';
    default:
      return 'your schedule changed';
  }
}

function key(block: PlannedBlock): string {
  return `${block.taskId}#${block.chunkIndex}`;
}

function toInterval(block: PlannedBlock): Interval {
  return { start: block.start, end: block.end };
}

/**
 * Compare two plans.
 *
 * Blocks are matched by task and chunk index rather than by identity, because
 * the scheduler produces fresh objects each run. Matching this way means "the
 * second session of writing the report" is recognised as the same thing across
 * plans, which is what makes MOVED distinguishable from REMOVED plus ADDED.
 */
export function diffPlans(
  previous: PlannedBlock[],
  next: PlannedBlock[],
  context: DiffContext,
): PlanChange[] {
  const previousByKey = new Map(previous.map((block) => [key(block), block]));
  const nextByKey = new Map(next.map((block) => [key(block), block]));
  const changes: PlanChange[] = [];

  const title = (taskId: string): string => context.taskTitles.get(taskId) ?? 'This task';
  const cause = describeTrigger(context.trigger);

  for (const [blockKey, nextBlock] of nextByKey) {
    const previousBlock = previousByKey.get(blockKey);

    if (!previousBlock) {
      changes.push({
        kind: 'ADDED',
        taskId: nextBlock.taskId,
        next: toInterval(nextBlock),
        reason:
          `${title(nextBlock.taskId)} is scheduled for ` +
          `${describeMoment(nextBlock.start, context.timeZone, context.now)} ` +
          `(${describeDuration(durationMinutes(nextBlock))}).`,
      });
      continue;
    }

    const moved = previousBlock.start.getTime() !== nextBlock.start.getTime();
    const resized = durationMinutes(previousBlock) !== durationMinutes(nextBlock);

    if (!moved && !resized) {
      changes.push({
        kind: 'UNCHANGED',
        taskId: nextBlock.taskId,
        previous: toInterval(previousBlock),
        next: toInterval(nextBlock),
        reason: `${title(nextBlock.taskId)} stays where it is.`,
      });
      continue;
    }

    if (moved) {
      const shift = minutesBetween(previousBlock.start, nextBlock.start);
      const direction = shift > 0 ? 'later' : 'earlier';

      changes.push({
        kind: 'MOVED',
        taskId: nextBlock.taskId,
        previous: toInterval(previousBlock),
        next: toInterval(nextBlock),
        reason:
          `${title(nextBlock.taskId)} moved to ` +
          `${describeMoment(nextBlock.start, context.timeZone, context.now)} — ` +
          `${describeDuration(Math.abs(shift))} ${direction} — because ${cause}.`,
      });
      continue;
    }

    changes.push({
      kind: 'RESIZED',
      taskId: nextBlock.taskId,
      previous: toInterval(previousBlock),
      next: toInterval(nextBlock),
      reason:
        `${title(nextBlock.taskId)} is now ${describeDuration(durationMinutes(nextBlock))} ` +
        `instead of ${describeDuration(durationMinutes(previousBlock))}.`,
    });
  }

  for (const [blockKey, previousBlock] of previousByKey) {
    if (nextByKey.has(blockKey)) continue;

    changes.push({
      kind: 'REMOVED',
      taskId: previousBlock.taskId,
      previous: toInterval(previousBlock),
      reason:
        `${title(previousBlock.taskId)} came off ` +
        `${describeMoment(previousBlock.start, context.timeZone, context.now)}. ` +
        `It still needs a slot.`,
    });
  }

  // Most disruptive first — the user should not have to scroll past a list of
  // unchanged blocks to find what actually moved.
  const order: Record<PlanChange['kind'], number> = {
    REMOVED: 0,
    MOVED: 1,
    RESIZED: 2,
    ADDED: 3,
    UNCHANGED: 4,
  };

  return changes.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.next?.start.getTime() ?? a.previous?.start.getTime() ?? 0) -
        (b.next?.start.getTime() ?? b.previous?.start.getTime() ?? 0),
  );
}

/** One-line summary for the top of the confirmation card. */
export function summarizeChanges(changes: PlanChange[], trigger: string): string {
  const counts = changes.reduce<Record<string, number>>((accumulator, change) => {
    accumulator[change.kind] = (accumulator[change.kind] ?? 0) + 1;
    return accumulator;
  }, {});

  const parts: string[] = [];
  if (counts.MOVED) parts.push(`${counts.MOVED} moved`);
  if (counts.ADDED) parts.push(`${counts.ADDED} added`);
  if (counts.RESIZED) parts.push(`${counts.RESIZED} resized`);
  if (counts.REMOVED) parts.push(`${counts.REMOVED} needs a new slot`);

  if (parts.length === 0) return 'Nothing needed to change.';

  return `${parts.join(', ')} because ${describeTrigger(trigger)}.`;
}
