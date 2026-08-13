import { describe, expect, it } from 'vitest';
import { expandLabeledRoutines } from './availability';
import type { Interval, ProtectedTimeRule } from './types';

/** 2026-06-15 is a Monday. A full week, so day-of-week rules are exercised. */
const WEEK: Interval = {
  start: new Date('2026-06-15T00:00:00Z'),
  end: new Date('2026-06-22T00:00:00Z'),
};

function rule(overrides: Partial<ProtectedTimeRule> = {}): ProtectedTimeRule {
  return { kind: 'ROUTINE', ...overrides };
}

describe('expandLabeledRoutines', () => {
  it('expands an every-day rule to one instance per day', () => {
    const result = expandLabeledRoutines(
      [rule({ label: 'Lunch', startTime: '12:00', endTime: '13:00' })],
      WEEK,
      'UTC',
    );

    expect(result).toHaveLength(7);
    expect(result.every((entry) => entry.label === 'Lunch')).toBe(true);
  });

  it('expands a single day-of-week rule to exactly one instance', () => {
    const result = expandLabeledRoutines(
      [rule({ label: 'Team sync', dayOfWeek: 1, startTime: '10:00', endTime: '10:30' })],
      WEEK,
      'UTC',
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.start.toISOString()).toBe('2026-06-15T10:00:00.000Z');
  });

  it('never merges two labeled rules the way the scheduler-facing version does', () => {
    // This is the entire reason this function exists rather than reusing
    // expandProtectedTimes: two different routines sitting back-to-back must
    // still read as two things, not one anonymous blocked stretch.
    const result = expandLabeledRoutines(
      [
        rule({ label: 'Brush teeth', dayOfWeek: 1, startTime: '07:00', endTime: '07:10' }),
        rule({ label: 'Breakfast', dayOfWeek: 1, startTime: '07:10', endTime: '07:30' }),
      ],
      WEEK,
      'UTC',
    );

    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.label)).toEqual(['Brush teeth', 'Breakfast']);
  });

  it('keeps a "weekdays" routine as five separate labeled instances', () => {
    // Mirrors how the router actually stores it: one row per day, sharing a
    // label — never a single collapsed rule, which would have no way to
    // exclude the weekend.
    const weekdayRules = [1, 2, 3, 4, 5].map((dayOfWeek) =>
      rule({ label: 'Commute', dayOfWeek, startTime: '08:15', endTime: '08:45' }),
    );

    const result = expandLabeledRoutines(weekdayRules, WEEK, 'UTC');

    expect(result).toHaveLength(5);
    expect(result.every((entry) => entry.label === 'Commute')).toBe(true);
    // 2026-06-15 is a Monday; Saturday the 20th and Sunday the 21st must be absent.
    expect(result.some((entry) => entry.start.toISOString().startsWith('2026-06-20'))).toBe(false);
    expect(result.some((entry) => entry.start.toISOString().startsWith('2026-06-21'))).toBe(false);
  });

  it('labels an unlabeled rule rather than leaving it blank', () => {
    const result = expandLabeledRoutines(
      [rule({ dayOfWeek: 1, startTime: '09:00', endTime: '09:15' })],
      WEEK,
      'UTC',
    );

    expect(result[0]?.label).toBe('Protected time');
  });

  it('honours the one-off start/end form', () => {
    const result = expandLabeledRoutines(
      [
        rule({
          label: 'Deep work',
          start: new Date('2026-06-16T14:00:00Z'),
          end: new Date('2026-06-16T16:00:00Z'),
        }),
      ],
      WEEK,
      'UTC',
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      label: 'Deep work',
      start: new Date('2026-06-16T14:00:00Z'),
      end: new Date('2026-06-16T16:00:00Z'),
    });
  });

  it('returns results sorted by start time regardless of input order', () => {
    const result = expandLabeledRoutines(
      [
        rule({ label: 'Dinner', dayOfWeek: 1, startTime: '18:30', endTime: '19:15' }),
        rule({ label: 'Lunch', dayOfWeek: 1, startTime: '12:00', endTime: '13:00' }),
        rule({ label: 'Breakfast', dayOfWeek: 1, startTime: '07:00', endTime: '07:30' }),
      ],
      WEEK,
      'UTC',
    );

    expect(result.map((entry) => entry.label)).toEqual(['Breakfast', 'Lunch', 'Dinner']);
  });

  it('clips a one-off entry to the requested bounds', () => {
    const result = expandLabeledRoutines(
      [
        rule({
          label: 'Overruns the window',
          start: new Date('2026-06-10T00:00:00Z'),
          end: new Date('2026-06-30T00:00:00Z'),
        }),
      ],
      WEEK,
      'UTC',
    );

    expect(result[0]?.start).toEqual(WEEK.start);
    expect(result[0]?.end).toEqual(WEEK.end);
  });
});
