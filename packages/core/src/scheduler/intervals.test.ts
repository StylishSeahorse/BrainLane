import { describe, expect, it } from 'vitest';
import {
  alignUp,
  intersectIntervals,
  mergeIntervals,
  overlaps,
  subtractIntervals,
  totalMinutes,
} from './intervals';
import type { Interval } from './types';

const at = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 5, 15, hour, minute, 0, 0));
const span = (fromHour: number, toHour: number): Interval => ({
  start: at(fromHour),
  end: at(toHour),
});
const render = (intervals: Interval[]): string[] =>
  intervals.map((i) => `${i.start.toISOString().slice(11, 16)}-${i.end.toISOString().slice(11, 16)}`);

describe('overlaps', () => {
  it('treats intervals as half-open, so back-to-back blocks do not conflict', () => {
    expect(overlaps(span(9, 10), span(10, 11))).toBe(false);
    expect(overlaps(span(9, 10), span(9, 10))).toBe(true);
    expect(overlaps(span(9, 12), span(10, 11))).toBe(true);
    expect(overlaps(span(9, 11), span(10, 12))).toBe(true);
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and touching spans', () => {
    expect(render(mergeIntervals([span(9, 11), span(10, 12)]))).toEqual(['09:00-12:00']);
    expect(render(mergeIntervals([span(9, 10), span(10, 11)]))).toEqual(['09:00-11:00']);
    expect(render(mergeIntervals([span(9, 10), span(11, 12)]))).toEqual([
      '09:00-10:00',
      '11:00-12:00',
    ]);
  });

  it('is order independent and drops empty spans', () => {
    expect(render(mergeIntervals([span(11, 12), span(9, 10), span(10, 10)]))).toEqual([
      '09:00-10:00',
      '11:00-12:00',
    ]);
  });

  it('absorbs a fully contained span', () => {
    expect(render(mergeIntervals([span(9, 17), span(11, 12)]))).toEqual(['09:00-17:00']);
  });
});

describe('subtractIntervals', () => {
  it('punches a hole in the middle', () => {
    expect(render(subtractIntervals([span(9, 17)], [span(12, 13)]))).toEqual([
      '09:00-12:00',
      '13:00-17:00',
    ]);
  });

  it('trims the edges', () => {
    expect(render(subtractIntervals([span(9, 17)], [span(8, 10)]))).toEqual(['10:00-17:00']);
    expect(render(subtractIntervals([span(9, 17)], [span(16, 18)]))).toEqual(['09:00-16:00']);
  });

  it('removes everything when fully covered', () => {
    expect(subtractIntervals([span(9, 17)], [span(8, 18)])).toEqual([]);
  });

  it('handles several cuts, including overlapping ones', () => {
    expect(
      render(subtractIntervals([span(9, 17)], [span(10, 11), span(10, 12), span(14, 15)])),
    ).toEqual(['09:00-10:00', '12:00-14:00', '15:00-17:00']);
  });

  it('leaves the base untouched when cuts miss entirely', () => {
    expect(render(subtractIntervals([span(9, 12)], [span(13, 14)]))).toEqual(['09:00-12:00']);
  });

  it('does not mutate its inputs', () => {
    const base = [span(9, 17)];
    const snapshot = render(base);
    subtractIntervals(base, [span(12, 13)]);
    expect(render(base)).toEqual(snapshot);
  });
});

describe('intersectIntervals', () => {
  it('returns only the shared parts', () => {
    expect(render(intersectIntervals([span(9, 12)], [span(11, 14)]))).toEqual(['11:00-12:00']);
    expect(intersectIntervals([span(9, 10)], [span(11, 12)])).toEqual([]);
    expect(render(intersectIntervals([span(9, 17)], [span(10, 11), span(14, 15)]))).toEqual([
      '10:00-11:00',
      '14:00-15:00',
    ]);
  });
});

describe('totalMinutes', () => {
  it('sums durations', () => {
    expect(totalMinutes([span(9, 10), span(14, 16)])).toBe(180);
    expect(totalMinutes([])).toBe(0);
  });
});

describe('alignUp', () => {
  it('rounds forward to the grid', () => {
    const anchor = at(0);
    expect(alignUp(at(9, 7), 15, anchor).toISOString()).toContain('09:15');
    expect(alignUp(at(9, 0), 15, anchor).toISOString()).toContain('09:00');
    expect(alignUp(at(9, 46), 30, anchor).toISOString()).toContain('10:00');
  });

  it('is a no-op for a non-positive granularity', () => {
    expect(alignUp(at(9, 7), 0, at(0)).getTime()).toBe(at(9, 7).getTime());
  });
});
