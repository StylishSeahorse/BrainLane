/**
 * Zoned-time arithmetic, without a dependency.
 *
 * The scheduler has to convert between two ideas of time constantly:
 *
 *   - A wall-clock intention: "I work 09:00–17:00". This is what the user
 *     means, and it stays 09:00 local on both sides of a DST change.
 *   - An instant: an absolute point on the timeline, which is what we compare
 *     against calendar events.
 *
 * Conflating the two is the classic calendar bug — a schedule that silently
 * shifts by an hour twice a year, or a "9am" block that lands at 8am for half
 * the year. Everything here exists to keep the two apart.
 *
 * We use `Intl.DateTimeFormat`, which carries the full IANA database, rather
 * than a date library. The operations needed are narrow and this keeps
 * `@fluid/core` dependency-free, which in turn keeps it trivially testable.
 */

/** A wall-clock time of day, timezone-free. Minutes since local midnight. */
export type MinutesOfDay = number;

/** Parse "09:00" or "9:00" into minutes since midnight. */
export function parseTimeOfDay(value: string): MinutesOfDay {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time of day: "${value}" (expected HH:MM)`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Time of day out of range: "${value}"`);

  return hours * 60 + minutes;
}

export function formatTimeOfDay(minutes: MinutesOfDay): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

export interface LocalDateTime {
  year: number;
  /** 1-12, not the 0-11 that `Date` uses. Off-by-one month bugs are silent. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Throws early on a bad IANA id, rather than silently falling back to UTC. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    formatter(timeZone);
  } catch {
    throw new Error(`Unknown time zone: "${timeZone}"`);
  }
}

/** What wall-clock time is it in `timeZone` at this instant? */
export function toLocal(instant: Date, timeZone: string): LocalDateTime {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Missing ${type} while formatting for ${timeZone}`);
    return Number(part.value);
  };

  // `hour12: false` yields 24 for midnight in some ICU versions.
  const hour = get('hour') % 24;

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset in milliseconds that `timeZone` was at, at this instant. */
export function offsetAt(instant: Date, timeZone: string): number {
  const local = toLocal(instant, timeZone);
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  // Discard sub-second precision so the difference is a clean offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in `timeZone` into an instant.
 *
 * Two passes: guess the offset by pretending the wall time is UTC, then correct
 * using the offset actually in force at the resulting instant. One correction
 * is enough for every real-world zone, because no zone's offset varies by more
 * than the ~26 hours a first guess can be wrong by.
 *
 * DST edge cases, stated rather than hidden:
 *   - Spring forward: 02:30 does not exist. We return the instant the clocks
 *     jump to, so a 02:30 block becomes a 03:00 block rather than an error.
 *   - Fall back: 01:30 happens twice. We return the first (pre-transition)
 *     occurrence. Either choice is defensible; picking deterministically is
 *     what matters, so a replan does not oscillate.
 */
export function fromLocal(local: LocalDateTime, timeZone: string): Date {
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second ?? 0,
  );

  const firstGuess = new Date(asIfUtc - offsetAt(new Date(asIfUtc), timeZone));
  const correctedOffset = offsetAt(firstGuess, timeZone);
  return new Date(asIfUtc - correctedOffset);
}

/** The instant at which a given local calendar day starts. */
export function startOfLocalDay(instant: Date, timeZone: string, dayOffset = 0): Date {
  const local = toLocal(instant, timeZone);
  return fromLocal(
    {
      year: local.year,
      month: local.month,
      day: local.day + dayOffset,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

/**
 * A wall-clock time on the local day containing `instant`.
 * This is how "09:00 on the day of X" becomes an absolute instant.
 */
export function localTimeOnDay(
  instant: Date,
  minutesOfDay: MinutesOfDay,
  timeZone: string,
  dayOffset = 0,
): Date {
  const local = toLocal(instant, timeZone);
  return fromLocal(
    {
      year: local.year,
      month: local.month,
      day: local.day + dayOffset,
      hour: Math.floor(minutesOfDay / 60),
      minute: minutesOfDay % 60,
      second: 0,
    },
    timeZone,
  );
}

/** Day of week in the target zone. 0 = Sunday, matching the schema. */
export function localDayOfWeek(instant: Date, timeZone: string): number {
  const local = toLocal(instant, timeZone);
  // Date.UTC + getUTCDay avoids the host timezone entirely.
  return new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE_MS;
}
