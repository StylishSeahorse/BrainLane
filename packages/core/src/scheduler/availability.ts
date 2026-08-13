/**
 * Turning rules into concrete time.
 *
 * Working hours, energy windows and protected time are all expressed as
 * wall-clock rules ("09:00–17:00 on weekdays"). The scheduler needs absolute
 * instants. This module expands the former into the latter across the planning
 * horizon, which is the only place DST has to be reasoned about — everything
 * downstream works in instants.
 */
import {
  DAY_MS,
  localDayOfWeek,
  localTimeOnDay,
  parseTimeOfDay,
  startOfLocalDay,
} from '../time/zoned';
import { mergeIntervals, subtractIntervals } from './intervals';
import type {
  EnergyLevel,
  EnergyWindowRule,
  Interval,
  ProtectedTimeRule,
  WorkingHoursRule,
} from './types';

/** Clip an interval to a bounding window; returns null if nothing remains. */
function clamp(interval: Interval, bounds: Interval): Interval | null {
  const start = interval.start < bounds.start ? bounds.start : interval.start;
  const end = interval.end > bounds.end ? bounds.end : interval.end;
  return start < end ? { start: new Date(start), end: new Date(end) } : null;
}

/**
 * Expand a wall-clock rule across every local day in the horizon.
 *
 * An end time at or before the start time is read as crossing midnight
 * (a 22:00–02:00 night-owl window), not as an error — plenty of people work
 * those hours, and rejecting the input would just make the app wrong for them.
 */
function expandDailyRule(
  rule: { dayOfWeek?: number | null; startTime: string; endTime: string },
  bounds: Interval,
  timeZone: string,
): Interval[] {
  const startMinutes = parseTimeOfDay(rule.startTime);
  const endMinutes = parseTimeOfDay(rule.endTime);
  const crossesMidnight = endMinutes <= startMinutes;

  const intervals: Interval[] = [];

  // Start a day early: a window that began yesterday evening can still cover
  // the start of the horizon.
  const firstDay = startOfLocalDay(bounds.start, timeZone, -1);
  const dayCount = Math.ceil((bounds.end.getTime() - firstDay.getTime()) / DAY_MS) + 1;

  for (let offset = 0; offset <= dayCount; offset += 1) {
    const dayStart = startOfLocalDay(firstDay, timeZone, offset);
    if (dayStart >= bounds.end) break;

    if (rule.dayOfWeek != null && localDayOfWeek(dayStart, timeZone) !== rule.dayOfWeek) {
      continue;
    }

    const start = localTimeOnDay(dayStart, startMinutes, timeZone);
    const end = localTimeOnDay(dayStart, endMinutes, timeZone, crossesMidnight ? 1 : 0);

    const clamped = clamp({ start, end }, bounds);
    if (clamped) intervals.push(clamped);
  }

  return intervals;
}

export interface AvailabilityInput {
  now: Date;
  timeZone: string;
  horizonDays: number;
  workingHours: WorkingHoursRule[];
  protectedTimes: ProtectedTimeRule[];
  busy: Interval[];
}

export interface Availability {
  /** The planning window itself. */
  bounds: Interval;
  /** Working hours, before anything is subtracted. */
  workable: Interval[];
  /** What is actually free: workable minus protected minus busy. */
  free: Interval[];
}

export function buildAvailability(input: AvailabilityInput): Availability {
  const bounds: Interval = {
    start: input.now,
    end: new Date(startOfLocalDay(input.now, input.timeZone).getTime() + input.horizonDays * DAY_MS),
  };

  const workable = mergeIntervals(
    input.workingHours.flatMap((rule) => expandDailyRule(rule, bounds, input.timeZone)),
  );

  const protectedIntervals = expandProtectedTimes(
    input.protectedTimes,
    bounds,
    input.timeZone,
  );

  // Protected time is subtracted first and separately from busy time. Both end
  // up removed, but keeping them distinct means an explanation can say *which*
  // one blocked a slot — "that's your lunch break" reads very differently from
  // "you have a meeting".
  const free = subtractIntervals(
    subtractIntervals(workable, protectedIntervals),
    mergeIntervals(input.busy),
  );

  return { bounds, workable, free };
}

export function expandProtectedTimes(
  rules: ProtectedTimeRule[],
  bounds: Interval,
  timeZone: string,
): Interval[] {
  const intervals: Interval[] = [];

  for (const rule of rules) {
    // One-off form: live hyperfocus protection, or a specific commitment.
    if (rule.start && rule.end) {
      const clamped = clamp({ start: rule.start, end: rule.end }, bounds);
      if (clamped) intervals.push(clamped);
      continue;
    }

    if (rule.startTime && rule.endTime) {
      intervals.push(
        ...expandDailyRule(
          { dayOfWeek: rule.dayOfWeek, startTime: rule.startTime, endTime: rule.endTime },
          bounds,
          timeZone,
        ),
      );
    }
  }

  return mergeIntervals(intervals);
}

export interface LabeledInterval extends Interval {
  label: string;
}

/**
 * Like `expandProtectedTimes`, but for showing routines rather than enforcing
 * them.
 *
 * The scheduler-facing version merges overlapping rules into anonymous
 * blocked intervals — correct for "is this time available", meaningless for
 * "what is this". Rendering "Lunch" and "Brush teeth" needs to know which
 * rule produced which interval, so this keeps them separate and labeled
 * instead of merging.
 */
export function expandLabeledRoutines(
  rules: ProtectedTimeRule[],
  bounds: Interval,
  timeZone: string,
): LabeledInterval[] {
  const results: LabeledInterval[] = [];

  for (const rule of rules) {
    const label = rule.label ?? 'Protected time';

    if (rule.start && rule.end) {
      const clamped = clamp({ start: rule.start, end: rule.end }, bounds);
      if (clamped) results.push({ ...clamped, label });
      continue;
    }

    if (rule.startTime && rule.endTime) {
      for (const interval of expandDailyRule(
        { dayOfWeek: rule.dayOfWeek, startTime: rule.startTime, endTime: rule.endTime },
        bounds,
        timeZone,
      )) {
        results.push({ ...interval, label });
      }
    }
  }

  return results.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface EnergyMap {
  /** Energy level windows, expanded to instants. */
  windows: Array<Interval & { level: EnergyLevel }>;
}

export function buildEnergyMap(
  rules: EnergyWindowRule[],
  bounds: Interval,
  timeZone: string,
): EnergyMap {
  const windows: Array<Interval & { level: EnergyLevel }> = [];

  for (const rule of rules) {
    for (const interval of expandDailyRule(rule, bounds, timeZone)) {
      windows.push({ ...interval, level: rule.level });
    }
  }

  return { windows };
}

const ENERGY_RANK: Record<EnergyLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Energy available at an instant. Unmapped time is MEDIUM: absence of
 * information should not push demanding work away from a slot that might be
 * perfectly good.
 */
export function energyAt(map: EnergyMap, instant: Date): EnergyLevel {
  let lowest: EnergyLevel | null = null;

  for (const window of map.windows) {
    if (instant >= window.start && instant < window.end) {
      // Overlapping declarations resolve to the most pessimistic. Scheduling
      // deep work into a slot the user flagged as low-focus wastes the slot.
      if (lowest === null || ENERGY_RANK[window.level] < ENERGY_RANK[lowest]) {
        lowest = window.level;
      }
    }
  }

  return lowest ?? 'MEDIUM';
}

/** Does a slot's energy meet what a task needs? */
export function energySatisfies(available: EnergyLevel, required: EnergyLevel): boolean {
  return ENERGY_RANK[available] >= ENERGY_RANK[required];
}
