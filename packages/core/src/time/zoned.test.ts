import { describe, expect, it } from 'vitest';
import {
  fromLocal,
  localDayOfWeek,
  localTimeOnDay,
  offsetAt,
  parseTimeOfDay,
  startOfLocalDay,
  toLocal,
} from './zoned';

describe('parseTimeOfDay', () => {
  it('parses valid times', () => {
    expect(parseTimeOfDay('09:00')).toBe(540);
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    expect(parseTimeOfDay('9:30')).toBe(570);
  });

  it('rejects nonsense rather than coercing it', () => {
    for (const bad of ['', '9', '25:00', '09:60', 'nine', '09:00:00']) {
      expect(() => parseTimeOfDay(bad)).toThrow();
    }
  });
});

describe('offsets across DST', () => {
  it('tracks the London transition', () => {
    // GMT in January, BST (+1) in July.
    expect(offsetAt(new Date('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(offsetAt(new Date('2026-07-15T12:00:00Z'), 'Europe/London')).toBe(3_600_000);
  });

  it('tracks the New York transition', () => {
    expect(offsetAt(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3_600_000);
    expect(offsetAt(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
  });

  it('handles a half-hour zone', () => {
    expect(offsetAt(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
  });
});

describe('fromLocal / toLocal round-trip', () => {
  it('round-trips ordinary times', () => {
    const local = { year: 2026, month: 6, day: 15, hour: 9, minute: 30, second: 0 };
    expect(toLocal(fromLocal(local, 'Europe/London'), 'Europe/London')).toEqual(local);
  });

  it('round-trips across many zones and months', () => {
    const zones = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney'];
    for (const zone of zones) {
      for (const month of [1, 4, 7, 10]) {
        const local = { year: 2026, month, day: 15, hour: 14, minute: 0, second: 0 };
        expect(toLocal(fromLocal(local, zone), zone), `${zone} month ${month}`).toEqual(local);
      }
    }
  });

  // The property that actually matters for scheduling: "9am" is 9am local on
  // both sides of a DST change, even though the UTC instants differ.
  it('keeps a wall-clock intention stable across a DST boundary', () => {
    const winter = fromLocal(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0 },
      'Europe/London',
    );
    const summer = fromLocal(
      { year: 2026, month: 7, day: 15, hour: 9, minute: 0, second: 0 },
      'Europe/London',
    );

    expect(winter.toISOString()).toBe('2026-01-15T09:00:00.000Z'); // GMT
    expect(summer.toISOString()).toBe('2026-07-15T08:00:00.000Z'); // BST

    // Different instants, same local intention — which is the whole point.
    expect(toLocal(winter, 'Europe/London').hour).toBe(9);
    expect(toLocal(summer, 'Europe/London').hour).toBe(9);
  });

  it('resolves the nonexistent spring-forward hour forward, not into an error', () => {
    // 2026-03-29 01:00 UTC: London clocks jump 01:00 -> 02:00. Local 01:30
    // never happens.
    const resolved = fromLocal(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0 },
      'Europe/London',
    );
    expect(Number.isNaN(resolved.getTime())).toBe(false);
    // Lands at or after the transition instant rather than before it.
    expect(resolved.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00Z'));
  });

  it('resolves the ambiguous fall-back hour deterministically', () => {
    // 2026-10-25: London clocks go back; local 01:30 occurs twice.
    const first = fromLocal(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 },
      'Europe/London',
    );
    const second = fromLocal(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30, second: 0 },
      'Europe/London',
    );
    // Stability is the requirement: a replan must not oscillate between the
    // two valid answers.
    expect(first.getTime()).toBe(second.getTime());
  });
});

describe('day helpers', () => {
  it('finds local midnight, not UTC midnight', () => {
    const midnight = startOfLocalDay(new Date('2026-07-15T23:30:00Z'), 'America/New_York');
    // 23:30Z on the 15th is 19:30 local, so local midnight is 04:00Z that day.
    expect(midnight.toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(toLocal(midnight, 'America/New_York').hour).toBe(0);
  });

  it('places a wall-clock time on the local day', () => {
    const nineAm = localTimeOnDay(new Date('2026-07-15T23:30:00Z'), 540, 'America/New_York');
    expect(toLocal(nineAm, 'America/New_York').hour).toBe(9);
    expect(toLocal(nineAm, 'America/New_York').day).toBe(15);
  });

  it('rolls over month boundaries when offsetting days', () => {
    const nextDay = startOfLocalDay(new Date('2026-01-31T12:00:00Z'), 'UTC', 1);
    expect(toLocal(nextDay, 'UTC')).toMatchObject({ year: 2026, month: 2, day: 1 });
  });

  it('reports day of week in the target zone, not the host zone', () => {
    // 2026-07-15T02:00Z is Wednesday in UTC but still Tuesday in New York.
    const instant = new Date('2026-07-15T02:00:00Z');
    expect(localDayOfWeek(instant, 'UTC')).toBe(3);
    expect(localDayOfWeek(instant, 'America/New_York')).toBe(2);
  });
});
