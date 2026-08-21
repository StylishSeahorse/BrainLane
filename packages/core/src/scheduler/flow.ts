/**
 * Playlist projection — where the rest of the day actually lands.
 *
 * A time-blocked plan says a task starts at 14:00. Ten minutes into overrunning
 * the previous one, that is no longer true, and every remaining time on screen
 * is quietly wrong. For someone using the schedule as external structure that
 * is worse than useless: the plan stops matching the room, so they stop
 * trusting the plan.
 *
 * So the day is also modelled as a sequence. Work items keep their order but
 * not their times — they flow from wherever "now" actually is. Meetings do not
 * move, because they belong to other people, and work is pushed around them.
 *
 * Pure and clock-free like everything else in this package: `now` is passed in,
 * which is what makes "you are running 25 minutes late" testable rather than
 * something you can only observe by waiting.
 */
import { addMinutes, minutesBetween } from '../time/zoned';
import type { Interval } from './types';

export interface FlowItem {
  id: string;
  /** Where the plan says it goes. */
  plannedStart: Date;
  plannedEnd: Date;
  /**
   * Fixed items are other people's commitments — meetings, appointments. They
   * happen when they happen; the sequence bends around them.
   */
  isFixed: boolean;
  /** Finished work still occupies its slot in the day's history. */
  isDone: boolean;
  /**
   * When the timer was started against this, if it is running.
   *
   * This is what separates "overrunning" from "never started", and the two
   * demand opposite projections. A block whose planned hour has passed might
   * be work in its ninetieth minute, or work nobody has touched — guessing
   * wrong means either inventing progress that did not happen or wiping out
   * progress that did. The timer is the only honest witness, so the caller
   * passes it rather than the projection inferring from the clock.
   */
  startedAt?: Date | null;
}

export interface ProjectedItem extends FlowItem {
  /** Where it now looks like it will actually happen. */
  projectedStart: Date;
  projectedEnd: Date;
  /** Positive when it has slipped later than planned. */
  driftMinutes: number;
  /** True while `now` sits inside the projection. */
  isCurrent: boolean;
}

export interface FlowOptions {
  now: Date;
  /** Breathing room between work items. Transitions cost something. */
  bufferMinutes?: number;
}

/**
 * Project a day's remaining sequence forward from `now`.
 *
 * Items are consumed in planned order. Completed ones are reported unchanged —
 * they are history, and rewriting history to make the arithmetic tidy is how a
 * planner starts lying. Everything still to come flows from the later of "now"
 * and the moment the previous item finishes.
 */
export function projectFlow(items: FlowItem[], options: FlowOptions): ProjectedItem[] {
  const { now } = options;
  const buffer = Math.max(0, options.bufferMinutes ?? 0);

  const ordered = [...items].sort(
    (a, b) => a.plannedStart.getTime() - b.plannedStart.getTime() || a.id.localeCompare(b.id),
  );

  // Fixed items are the walls the sequence has to fit between. Collected up
  // front so a work item can be pushed past a meeting it would have run into,
  // rather than being projected on top of one.
  const walls: Interval[] = ordered
    .filter((item) => item.isFixed && !item.isDone)
    .map((item) => ({ start: item.plannedStart, end: item.plannedEnd }));

  // Nothing that has not begun can begin in the past, so the sequence flows
  // from now. Items already running are the exception, handled below.
  let cursor = now;
  const projected: ProjectedItem[] = [];
  const later = (a: Date, b: Date): Date => (a > b ? a : b);

  for (const item of ordered) {
    if (item.isDone) {
      // History, reported as it happened. The only forward effect is that the
      // transition out of it still costs something.
      cursor = later(cursor, addMinutes(item.plannedEnd, buffer));
      projected.push({
        ...item,
        projectedStart: item.plannedStart,
        projectedEnd: item.plannedEnd,
        driftMinutes: 0,
        isCurrent: false,
      });
      continue;
    }

    if (item.isFixed) {
      // A meeting keeps its time whatever the sequence is doing. If work has
      // overrun into it, that collision is real and the user is about to be
      // late — saying so is the point, not hiding it by moving the meeting.
      cursor = later(cursor, item.plannedEnd);
      projected.push({
        ...item,
        projectedStart: item.plannedStart,
        projectedEnd: item.plannedEnd,
        driftMinutes: 0,
        isCurrent: now >= item.plannedStart && now < item.plannedEnd,
      });
      continue;
    }

    const durationMinutes = minutesBetween(item.plannedStart, item.plannedEnd);

    if (item.startedAt) {
      // In progress. It began when it began, and the earliest it can finish is
      // now — so an overrun shows as the end sliding, never the start.
      const start = item.startedAt;
      const end = later(now, item.plannedEnd);
      cursor = addMinutes(end, buffer);

      projected.push({
        ...item,
        projectedStart: start,
        projectedEnd: end,
        driftMinutes: 0,
        isCurrent: true,
      });
      continue;
    }

    // Not started. Never earlier than planned — a sequence that pulls work
    // forward the moment you finish early turns every good day into a longer
    // one — and never earlier than now, which `cursor` already guarantees.
    let start = later(cursor, item.plannedStart);
    let end = addMinutes(start, durationMinutes);

    // Slide past any meeting this would now collide with. Walls are in
    // chronological order, so one pass is enough to clear all of them.
    for (const wall of walls) {
      if (start < wall.end && end > wall.start) {
        start = wall.end;
        end = addMinutes(start, durationMinutes);
      }
    }

    projected.push({
      ...item,
      projectedStart: start,
      projectedEnd: end,
      driftMinutes: Math.round(minutesBetween(item.plannedStart, start)),
      isCurrent: now >= start && now < end,
    });

    cursor = addMinutes(end, buffer);
  }

  return projected;
}

/**
 * How far behind the day as a whole is running.
 *
 * The largest drift among work still to come, which is the number that answers
 * "will I finish?" — an average would let one badly slipped item disappear
 * into a set of on-time ones.
 */
export function totalDrift(projected: ProjectedItem[]): number {
  return projected
    .filter((item) => !item.isDone && !item.isFixed)
    .reduce((worst, item) => Math.max(worst, item.driftMinutes), 0);
}
