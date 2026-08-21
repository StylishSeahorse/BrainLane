/**
 * How much of a day is actually available, and how much has been promised.
 *
 * The premise this whole product rests on is that a day has a size. A task
 * list can grow without limit; a Tuesday cannot. Counting tasks hides that —
 * "six things left" says nothing about whether six things fit — so everything
 * here is measured in minutes against real working hours, with meetings,
 * routines and transition buffers already removed.
 *
 * Overcommitment is reported, never silently corrected. Being told "this is
 * ninety minutes more than you have" while there is still time to choose is
 * the entire point; discovering it at 6pm is not.
 */
import { durationMinutes, intersectIntervals, mergeIntervals, subtractIntervals, totalMinutes } from './intervals';
import type { Interval } from './types';

export interface CapacityInput {
  /** The day being measured, as a half-open local-midnight-to-midnight range. */
  day: Interval;
  /** Working hours for this day, already expanded to instants. */
  workable: Interval[];
  /** Routines, breaks and anything else the scheduler may never allocate. */
  protectedTimes: Interval[];
  /** Real calendar events that consume time. */
  meetings: Interval[];
  /**
   * Scheduled time in areas that do not count toward working capacity —
   * personal errands, appointments, anything on a different ledger.
   *
   * Treated like meetings rather than dropped. A dentist appointment at 11am
   * genuinely removes eleven o'clock from the working day; excluding it
   * outright would report free time that does not exist, which is the precise
   * failure this meter is built to prevent. It is simply not counted as *work
   * committed*, so the day's load stays an honest answer to "how much did I
   * promise?" rather than "how busy am I?".
   */
  personal?: Interval[];
  /** Work sessions currently on the plan for this day. */
  planned: Interval[];
  /**
   * Minutes of breathing room between sessions. Charged once per planned
   * session because the cost is the transition into it, not the gap either
   * side — counting both ends would double-bill every block.
   */
  bufferMinutes: number;
  /**
   * Sessions already finished. Kept apart from `planned` so the meter can say
   * "you have done 2h of the 5h you set aside" rather than treating completed
   * work as though it were still pending.
   */
  completed?: Interval[];
}

export interface Capacity {
  /** Working hours inside the day, before anything is removed. */
  workableMinutes: number;
  /** Time lost to meetings, within working hours. */
  meetingMinutes: number;
  /** Time lost to routines and breaks, within working hours. */
  protectedMinutes: number;
  /** Time lost to non-working areas, within working hours. */
  personalMinutes: number;
  /** What is genuinely left for work: workable − meetings − protected − personal. */
  capacityMinutes: number;
  /** Planned work sessions, excluding completed ones. */
  plannedMinutes: number;
  /** Transition cost of those sessions. */
  bufferMinutes: number;
  /** Planned work already finished. */
  completedMinutes: number;
  /** plannedMinutes + bufferMinutes, i.e. what the day still owes. */
  committedMinutes: number;
  /** Positive when the day is overbooked, otherwise 0. */
  overcommittedMinutes: number;
  /** Unspoken-for time. 0 once overcommitted. */
  freeMinutes: number;
  /** committed ÷ capacity, clamped to [0, 2] so a wild overbook stays plottable. */
  load: number;
}

/** Minutes of `parts` that fall inside `within`. */
function minutesInside(parts: Interval[], within: Interval[]): number {
  return totalMinutes(intersectIntervals(mergeIntervals(parts), mergeIntervals(within)));
}

export function computeCapacity(input: CapacityInput): Capacity {
  const workable = mergeIntervals(
    intersectIntervals(mergeIntervals(input.workable), [input.day]),
  );
  const workableMinutes = totalMinutes(workable);

  // Both are measured against working hours only. A 7am meeting before the
  // workday starts does not reduce a 9-to-5 capacity, and counting it would
  // report a deficit the person cannot act on.
  const meetingMinutes = minutesInside(input.meetings, workable);
  const protectedMinutes = minutesInside(
    // Protected time that a meeting already covers must not be charged twice.
    subtractIntervals(mergeIntervals(input.protectedTimes), mergeIntervals(input.meetings)),
    workable,
  );
  // Same rule again, one layer down: personal time already covered by a
  // meeting or a routine is not a third deduction. Each minute is spent once.
  const personalMinutes = minutesInside(
    subtractIntervals(
      mergeIntervals(input.personal ?? []),
      mergeIntervals([...input.meetings, ...input.protectedTimes]),
    ),
    workable,
  );

  const capacityMinutes = Math.max(
    0,
    workableMinutes - meetingMinutes - protectedMinutes - personalMinutes,
  );

  const completed = input.completed ?? [];
  const completedMinutes = completed.reduce((sum, part) => sum + durationMinutes(part), 0);
  const plannedMinutes = input.planned.reduce((sum, part) => sum + durationMinutes(part), 0);
  const bufferMinutes = input.planned.length * Math.max(0, input.bufferMinutes);

  const committedMinutes = plannedMinutes + bufferMinutes;
  const overcommittedMinutes = Math.max(0, committedMinutes - capacityMinutes);

  return {
    workableMinutes,
    meetingMinutes,
    protectedMinutes,
    personalMinutes,
    capacityMinutes,
    plannedMinutes,
    bufferMinutes,
    completedMinutes,
    committedMinutes,
    overcommittedMinutes,
    freeMinutes: Math.max(0, capacityMinutes - committedMinutes),
    load: capacityMinutes === 0 ? (committedMinutes > 0 ? 2 : 0)
      : Math.min(2, committedMinutes / capacityMinutes),
  };
}

/** How full the day is, in words rather than a percentage. */
export type LoadVerdict = 'empty' | 'light' | 'balanced' | 'full' | 'over';

export function verdictFor(capacity: Capacity): LoadVerdict {
  if (capacity.overcommittedMinutes > 0) return 'over';
  if (capacity.committedMinutes === 0) return 'empty';
  if (capacity.load >= 0.9) return 'full';
  if (capacity.load >= 0.5) return 'balanced';
  return 'light';
}
