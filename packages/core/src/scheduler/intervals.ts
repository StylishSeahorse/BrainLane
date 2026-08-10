/**
 * Interval algebra over half-open ranges [start, end).
 *
 * Half-open is what makes adjacency work cleanly: a block ending at 10:00 and
 * one starting at 10:00 do not overlap, which is what a user means by
 * back-to-back. Using closed intervals here produces phantom conflicts.
 */
import type { Interval } from './types';

export function durationMinutes(interval: Interval): number {
  return (interval.end.getTime() - interval.start.getTime()) / 60_000;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Sort by start, then end. Every function below assumes this ordering. */
export function sortIntervals(intervals: Interval[]): Interval[] {
  return [...intervals].sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime(),
  );
}

/** Merge overlapping and touching intervals into a minimal set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = sortIntervals(intervals.filter((i) => i.start < i.end));
  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // `<=` rather than `<`: touching intervals merge, so 9-10 and 10-11 become
    // a single 9-11 rather than two adjacent free-slot boundaries.
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: new Date(interval.start), end: new Date(interval.end) });
    }
  }

  return merged;
}

/** Everything in `base` that is not covered by `cut`. */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  const blockers = mergeIntervals(cut);
  const result: Interval[] = [];

  for (const interval of mergeIntervals(base)) {
    let cursor = interval.start;

    for (const blocker of blockers) {
      if (blocker.end <= cursor) continue; // Entirely before the remaining span.
      if (blocker.start >= interval.end) break; // Sorted, so nothing later applies.

      if (blocker.start > cursor) {
        result.push({ start: new Date(cursor), end: new Date(blocker.start) });
      }
      if (blocker.end > cursor) cursor = blocker.end;
      if (cursor >= interval.end) break;
    }

    if (cursor < interval.end) {
      result.push({ start: new Date(cursor), end: new Date(interval.end) });
    }
  }

  return result;
}

/** The overlapping parts of two interval sets. */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const result: Interval[] = [];

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = new Date(Math.max(left[i]!.start.getTime(), right[j]!.start.getTime()));
    const end = new Date(Math.min(left[i]!.end.getTime(), right[j]!.end.getTime()));
    if (start < end) result.push({ start, end });

    if (left[i]!.end < right[j]!.end) i += 1;
    else j += 1;
  }

  return result;
}

export function totalMinutes(intervals: Interval[]): number {
  return intervals.reduce((sum, interval) => sum + durationMinutes(interval), 0);
}

/**
 * Round a start time up to the next grid boundary.
 *
 * The grid is anchored to the local day rather than the epoch, so zones with a
 * half-hour offset still land on :00 and :30 locally.
 */
export function alignUp(instant: Date, granularityMinutes: number, anchor: Date): Date {
  if (granularityMinutes <= 0) return instant;

  const granularityMs = granularityMinutes * 60_000;
  const elapsed = instant.getTime() - anchor.getTime();
  const aligned = Math.ceil(elapsed / granularityMs) * granularityMs;
  return new Date(anchor.getTime() + aligned);
}
