import { describe, expect, it } from 'vitest';
import { projectFlow, totalDrift, type FlowItem } from './flow';

const at = (hhmm: string) => new Date(`2026-06-15T${hhmm}:00Z`);
const hhmm = (date: Date) => date.toISOString().slice(11, 16);

function work(
  id: string,
  start: string,
  end: string,
  extra: Partial<FlowItem> = {},
): FlowItem {
  return {
    id,
    plannedStart: at(start),
    plannedEnd: at(end),
    isFixed: false,
    isDone: false,
    ...extra,
  };
}

function meeting(id: string, start: string, end: string): FlowItem {
  return { id, plannedStart: at(start), plannedEnd: at(end), isFixed: true, isDone: false };
}

describe('projectFlow', () => {
  it('leaves an on-time day exactly as planned', () => {
    const result = projectFlow([work('a', '09:00', '10:00'), work('b', '10:00', '11:00')], {
      now: at('09:00'),
    });

    expect(result.map((item) => hhmm(item.projectedStart))).toEqual(['09:00', '10:00']);
    expect(totalDrift(result)).toBe(0);
  });

  it('pushes later work when the running item has overrun', () => {
    // Started at 09:00 for a planned hour; it is 10:25 and the timer is still
    // going. The overrun shows as the end sliding, not the start.
    const result = projectFlow(
      [
        work('running', '09:00', '10:00', { startedAt: at('09:00') }),
        work('next', '10:00', '11:00'),
      ],
      { now: at('10:25') },
    );

    expect(hhmm(result[0]!.projectedStart)).toBe('09:00');
    expect(hhmm(result[0]!.projectedEnd)).toBe('10:25');
    expect(hhmm(result[1]!.projectedStart)).toBe('10:25');
    expect(result[1]!.driftMinutes).toBe(25);
    expect(totalDrift(result)).toBe(25);
  });

  it('distinguishes work that overran from work nobody started', () => {
    // Same clock, same plan — the only difference is the timer. Without that
    // signal the projection would have to guess, and either guess invents or
    // erases an hour and a half of someone's morning.
    const overran = projectFlow(
      [work('x', '10:00', '11:00', { startedAt: at('10:00') })],
      { now: at('11:30') },
    );
    const untouched = projectFlow([work('x', '10:00', '11:00')], { now: at('11:30') });

    expect(hhmm(overran[0]!.projectedStart)).toBe('10:00');
    expect(hhmm(untouched[0]!.projectedStart)).toBe('11:30');
  });

  it('never pulls work earlier than planned when you finish ahead', () => {
    // Finishing early should give back the time, not start the afternoon's
    // work at 10:10 and quietly extend the day at the other end.
    const result = projectFlow(
      [work('a', '09:00', '10:00', { isDone: true }), work('b', '14:00', '15:00')],
      { now: at('09:10') },
    );

    expect(hhmm(result[1]!.projectedStart)).toBe('14:00');
    expect(result[1]!.driftMinutes).toBe(0);
  });

  it('keeps meetings where they are and bends work around them', () => {
    const result = projectFlow(
      [
        work('a', '09:00', '10:00', { isDone: true }),
        meeting('standup', '11:00', '11:30'),
        work('b', '10:00', '11:00'),
      ],
      { now: at('10:50') },
    );

    const standup = result.find((item) => item.id === 'standup')!;
    const b = result.find((item) => item.id === 'b')!;

    // The meeting does not move...
    expect(hhmm(standup.projectedStart)).toBe('11:00');
    // ...and the hour of work that would have collided lands after it.
    expect(hhmm(b.projectedStart)).toBe('11:30');
  });

  it('reports completed work at its original time', () => {
    // History is not re-projected. Rewriting it to tidy the arithmetic is how
    // a planner starts telling comfortable lies.
    const result = projectFlow(
      [work('done', '09:00', '10:00', { isDone: true }), work('next', '10:00', '11:00')],
      { now: at('11:30') },
    );

    expect(hhmm(result[0]!.projectedStart)).toBe('09:00');
    expect(hhmm(result[0]!.projectedEnd)).toBe('10:00');
    expect(result[0]!.driftMinutes).toBe(0);
    expect(hhmm(result[1]!.projectedStart)).toBe('11:30');
  });

  it('charges the transition buffer between items', () => {
    const result = projectFlow(
      [work('a', '09:00', '10:00', { isDone: true }), work('b', '10:00', '11:00')],
      { now: at('10:00'), bufferMinutes: 15 },
    );

    expect(hhmm(result[1]!.projectedStart)).toBe('10:15');
  });

  it('marks the item that "now" is sitting inside', () => {
    const result = projectFlow(
      [work('a', '09:00', '10:00', { isDone: true }), work('b', '10:00', '11:00')],
      { now: at('10:30') },
    );

    expect(result.find((item) => item.isCurrent)?.id).toBe('b');
  });

  it('treats a running item as current even before its planned start', () => {
    // Starting something early is a legitimate thing to do, and the flow view
    // has to point at what the person is actually doing.
    const result = projectFlow([work('early', '14:00', '15:00', { startedAt: at('09:00') })], {
      now: at('09:30'),
    });

    expect(result[0]!.isCurrent).toBe(true);
  });

  it('is stable regardless of input order', () => {
    const forwards = projectFlow([work('a', '09:00', '10:00'), work('b', '10:00', '11:00')], {
      now: at('09:00'),
    });
    const backwards = projectFlow([work('b', '10:00', '11:00'), work('a', '09:00', '10:00')], {
      now: at('09:00'),
    });

    expect(forwards.map((item) => item.id)).toEqual(backwards.map((item) => item.id));
    expect(forwards.map((item) => hhmm(item.projectedStart))).toEqual(
      backwards.map((item) => hhmm(item.projectedStart)),
    );
  });

  it('handles an empty day', () => {
    expect(projectFlow([], { now: at('09:00') })).toEqual([]);
    expect(totalDrift([])).toBe(0);
  });
});
