import { describe, expect, it } from 'vitest';
import { chunkTask, plan } from './plan';
import type { PlannedBlock, SchedulableTask, SchedulingInput } from './types';

/**
 * 2026-06-15 is a Monday. `now` is 08:00 UTC, an hour before the working day
 * opens, so tests start from a clean 09:00 boundary.
 */
const NOW = new Date('2026-06-15T08:00:00Z');

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  startTime: '09:00',
  endTime: '17:00',
}));

function makeTask(overrides: Partial<SchedulableTask> & { id: string }): SchedulableTask {
  return {
    title: `Task ${overrides.id}`,
    remainingMinutes: 60,
    priority: 'MEDIUM',
    energy: 'MEDIUM',
    isSplittable: true,
    minChunkMinutes: 25,
    maxChunkMinutes: 90,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    now: NOW,
    timeZone: 'UTC',
    horizonDays: 7,
    tasks: [],
    busy: [],
    pinned: [],
    workingHours: WEEKDAYS_9_TO_5,
    energyWindows: [],
    protectedTimes: [],
    preferences: { bufferMinutes: 0, slotGranularityMinutes: 15 },
    ...overrides,
  };
}

const hhmm = (date: Date): string => date.toISOString().slice(11, 16);
const dayAndTime = (date: Date): string => date.toISOString().slice(5, 16).replace('T', ' ');
const blocksFor = (blocks: PlannedBlock[], taskId: string): PlannedBlock[] =>
  blocks.filter((block) => block.taskId === taskId);

describe('chunkTask', () => {
  it('leaves work that fits in one sitting alone', () => {
    expect(chunkTask(makeTask({ id: 'a', remainingMinutes: 60, maxChunkMinutes: 90 }))).toEqual([60]);
  });

  it('never splits a task marked unsplittable', () => {
    expect(
      chunkTask(makeTask({ id: 'a', remainingMinutes: 240, isSplittable: false })),
    ).toEqual([240]);
  });

  it('splits evenly rather than leaving a stub', () => {
    // 100 minutes with a 90-minute cap becomes 50 + 50, not 90 + 10. A
    // ten-minute fragment is a block that gets skipped.
    expect(chunkTask(makeTask({ id: 'a', remainingMinutes: 100, maxChunkMinutes: 90 }))).toEqual([
      50, 50,
    ]);
  });

  it('distributes an uneven total across chunks', () => {
    const chunks = chunkTask(makeTask({ id: 'a', remainingMinutes: 200, maxChunkMinutes: 90 }));
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(200);
    expect(Math.max(...chunks) - Math.min(...chunks)).toBeLessThanOrEqual(1);
  });

  it('prefers fewer, longer sittings over chunks below the useful minimum', () => {
    const chunks = chunkTask(
      makeTask({ id: 'a', remainingMinutes: 60, maxChunkMinutes: 25, minChunkMinutes: 25 }),
    );
    expect(chunks.every((size) => size >= 25)).toBe(true);
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(60);
  });
});

describe('basic placement', () => {
  it('schedules into working hours, not before them', () => {
    const result = plan(makeInput({ tasks: [makeTask({ id: 'a', remainingMinutes: 60 })] }));

    expect(result.blocks).toHaveLength(1);
    expect(hhmm(result.blocks[0]!.start)).toBe('09:00');
    expect(hhmm(result.blocks[0]!.end)).toBe('10:00');
  });

  it('never schedules outside working hours', () => {
    const result = plan(
      makeInput({
        tasks: Array.from({ length: 20 }, (_, index) =>
          makeTask({ id: `t${index}`, remainingMinutes: 60 }),
        ),
      }),
    );

    for (const block of result.blocks) {
      const startHour = block.start.getUTCHours();
      const endHour = block.end.getUTCHours() + block.end.getUTCMinutes() / 60;
      expect(startHour).toBeGreaterThanOrEqual(9);
      expect(endHour).toBeLessThanOrEqual(17);
      // Weekdays only.
      expect([1, 2, 3, 4, 5]).toContain(block.start.getUTCDay());
    }
  });

  it('does not double-book', () => {
    const result = plan(
      makeInput({
        tasks: Array.from({ length: 10 }, (_, index) =>
          makeTask({ id: `t${index}`, remainingMinutes: 90 }),
        ),
      }),
    );

    const sorted = [...result.blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.start.getTime()).toBeGreaterThanOrEqual(sorted[i - 1]!.end.getTime());
    }
  });

  it('schedules around existing meetings', () => {
    const result = plan(
      makeInput({
        busy: [
          { start: new Date('2026-06-15T09:00:00Z'), end: new Date('2026-06-15T11:00:00Z') },
        ],
        tasks: [makeTask({ id: 'a', remainingMinutes: 60 })],
      }),
    );

    expect(hhmm(result.blocks[0]!.start)).toBe('11:00');
  });

  it('inserts the configured buffer between blocks', () => {
    const result = plan(
      makeInput({
        preferences: { bufferMinutes: 15, slotGranularityMinutes: 15 },
        tasks: [
          makeTask({ id: 'a', remainingMinutes: 60 }),
          makeTask({ id: 'b', remainingMinutes: 60 }),
        ],
      }),
    );

    const sorted = [...result.blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
    const gap = (sorted[1]!.start.getTime() - sorted[0]!.end.getTime()) / 60_000;
    expect(gap).toBeGreaterThanOrEqual(15);
  });
});

// The hard constraint. Protected time outranks every other consideration,
// including an urgent deadline.
describe('protected time is inviolable', () => {
  it('refuses to schedule over a recurring break', () => {
    const result = plan(
      makeInput({
        protectedTimes: [
          { kind: 'ROUTINE', label: 'Lunch', dayOfWeek: null, startTime: '12:00', endTime: '13:00' },
        ],
        tasks: Array.from({ length: 12 }, (_, index) =>
          makeTask({ id: `t${index}`, remainingMinutes: 60 }),
        ),
      }),
    );

    for (const block of result.blocks) {
      const startMinutes = block.start.getUTCHours() * 60 + block.start.getUTCMinutes();
      const endMinutes = block.end.getUTCHours() * 60 + block.end.getUTCMinutes();
      const overlapsLunch = startMinutes < 13 * 60 && endMinutes > 12 * 60;
      expect(overlapsLunch, `block ${dayAndTime(block.start)} overlaps lunch`).toBe(false);
    }
  });

  it('protects a live hyperfocus session even from an urgent deadline', () => {
    const result = plan(
      makeInput({
        protectedTimes: [
          {
            kind: 'HYPERFOCUS',
            start: new Date('2026-06-15T09:00:00Z'),
            end: new Date('2026-06-15T16:00:00Z'),
          },
        ],
        tasks: [
          makeTask({
            id: 'urgent',
            remainingMinutes: 60,
            priority: 'URGENT',
            deadline: new Date('2026-06-15T12:00:00Z'),
          }),
        ],
      }),
    );

    // The only pre-deadline time was protected, so it goes after — and is
    // reported as missing the deadline rather than quietly overrunning it.
    for (const block of result.blocks) {
      expect(block.start.getTime()).toBeGreaterThanOrEqual(
        new Date('2026-06-15T16:00:00Z').getTime(),
      );
    }
    expect(result.unscheduled.map((entry) => entry.reason)).toContain('DEADLINE_UNREACHABLE');
  });
});

describe('deadlines', () => {
  it('schedules the tighter deadline first', () => {
    const result = plan(
      makeInput({
        tasks: [
          makeTask({
            id: 'later',
            remainingMinutes: 60,
            deadline: new Date('2026-06-19T17:00:00Z'),
          }),
          makeTask({
            id: 'sooner',
            remainingMinutes: 60,
            deadline: new Date('2026-06-15T17:00:00Z'),
          }),
        ],
      }),
    );

    const sooner = blocksFor(result.blocks, 'sooner')[0]!;
    const later = blocksFor(result.blocks, 'later')[0]!;
    expect(sooner.start.getTime()).toBeLessThan(later.start.getTime());
  });

  it('ranks by slack, so a small urgent task beats a large distant one', () => {
    const result = plan(
      makeInput({
        tasks: [
          makeTask({
            id: 'big-distant',
            remainingMinutes: 240,
            deadline: new Date('2026-06-19T17:00:00Z'),
          }),
          makeTask({
            id: 'small-imminent',
            remainingMinutes: 30,
            deadline: new Date('2026-06-15T11:00:00Z'),
          }),
        ],
      }),
    );

    expect(blocksFor(result.blocks, 'small-imminent')[0]!.start.getTime()).toBeLessThan(
      blocksFor(result.blocks, 'big-distant')[0]!.start.getTime(),
    );
  });

  it('reports an impossible deadline instead of pretending it fits', () => {
    const result = plan(
      makeInput({
        tasks: [
          makeTask({
            id: 'impossible',
            remainingMinutes: 600, // 10h of work
            deadline: new Date('2026-06-15T12:00:00Z'), // 3h of runway
            isSplittable: false,
          }),
        ],
      }),
    );

    expect(result.unscheduled.some((entry) => entry.taskId === 'impossible')).toBe(true);
    // The explanation is a sentence, not a constraint code.
    expect(result.unscheduled[0]!.explanation).toMatch(/[a-z]{4,}\s+[a-z]{2,}/i);
  });

  it('respects earliestStart', () => {
    const result = plan(
      makeInput({
        tasks: [
          makeTask({
            id: 'waiting',
            remainingMinutes: 60,
            earliestStart: new Date('2026-06-17T09:00:00Z'),
          }),
        ],
      }),
    );

    expect(result.blocks[0]!.start.getTime()).toBeGreaterThanOrEqual(
      new Date('2026-06-17T09:00:00Z').getTime(),
    );
  });
});

describe('energy matching', () => {
  it('keeps demanding work out of a declared low-focus window', () => {
    const result = plan(
      makeInput({
        energyWindows: [
          { dayOfWeek: null, startTime: '09:00', endTime: '13:00', level: 'HIGH' },
          { dayOfWeek: null, startTime: '13:00', endTime: '17:00', level: 'LOW' },
        ],
        tasks: [makeTask({ id: 'deep', remainingMinutes: 120, energy: 'HIGH' })],
      }),
    );

    for (const block of result.blocks) {
      expect(block.start.getUTCHours()).toBeLessThan(13);
    }
  });

  it('places low-energy work in a low-focus window happily', () => {
    const result = plan(
      makeInput({
        energyWindows: [
          { dayOfWeek: null, startTime: '09:00', endTime: '13:00', level: 'HIGH' },
          { dayOfWeek: null, startTime: '13:00', endTime: '17:00', level: 'LOW' },
        ],
        tasks: [
          makeTask({ id: 'deep', remainingMinutes: 240, energy: 'HIGH' }),
          makeTask({ id: 'admin', remainingMinutes: 60, energy: 'LOW' }),
        ],
      }),
    );

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(blocksFor(result.blocks, 'admin')).not.toHaveLength(0);
  });

  it('relaxes the energy preference rather than leaving a task unscheduled', () => {
    const result = plan(
      makeInput({
        energyWindows: [{ dayOfWeek: null, startTime: '09:00', endTime: '17:00', level: 'LOW' }],
        tasks: [makeTask({ id: 'deep', remainingMinutes: 60, energy: 'HIGH' })],
      }),
    );

    // Every window is low-focus. Scheduling it imperfectly beats not at all.
    expect(result.blocks).toHaveLength(1);
  });
});

describe('dependencies', () => {
  it('places a prerequisite before its dependent', () => {
    const result = plan(
      makeInput({
        tasks: [
          makeTask({ id: 'second', remainingMinutes: 60, dependsOn: ['first'] }),
          makeTask({ id: 'first', remainingMinutes: 60 }),
        ],
      }),
    );

    expect(blocksFor(result.blocks, 'first')[0]!.end.getTime()).toBeLessThanOrEqual(
      blocksFor(result.blocks, 'second')[0]!.start.getTime(),
    );
  });

  it('reports a dependency cycle instead of hanging or dropping tasks', () => {
    const result = plan(
      makeInput({
        tasks: [
          makeTask({ id: 'a', dependsOn: ['b'] }),
          makeTask({ id: 'b', dependsOn: ['a'] }),
        ],
      }),
    );

    expect(result.blocks).toHaveLength(0);
    expect(result.unscheduled.map((entry) => entry.reason)).toEqual([
      'DEPENDENCY_CYCLE',
      'DEPENDENCY_CYCLE',
    ]);
  });
});

describe('pinned blocks', () => {
  it('keeps a pinned block exactly where it is and routes around it', () => {
    const pinnedStart = new Date('2026-06-15T10:00:00Z');
    const pinnedEnd = new Date('2026-06-15T11:00:00Z');

    const result = plan(
      makeInput({
        pinned: [{ taskId: 'fixed', blockId: 'b1', start: pinnedStart, end: pinnedEnd }],
        tasks: [makeTask({ id: 'other', remainingMinutes: 120 })],
      }),
    );

    const pinned = blocksFor(result.blocks, 'fixed')[0]!;
    expect(pinned.start.getTime()).toBe(pinnedStart.getTime());
    expect(pinned.isPinned).toBe(true);

    for (const block of blocksFor(result.blocks, 'other')) {
      const conflicts = block.start < pinnedEnd && pinnedStart < block.end;
      expect(conflicts).toBe(false);
    }
  });
});

// Stability is a feature. A schedule that reshuffles wholesale stops working as
// the external structure the user is relying on.
describe('plan stability across replans', () => {
  it('keeps untouched blocks in place when replanning', () => {
    const tasks = [
      makeTask({ id: 'a', remainingMinutes: 60 }),
      makeTask({ id: 'b', remainingMinutes: 60 }),
      makeTask({ id: 'c', remainingMinutes: 60 }),
    ];

    const first = plan(makeInput({ tasks }));

    // A meeting appears in the afternoon, well after the existing blocks.
    const second = plan(
      makeInput({
        tasks,
        previous: first.blocks,
        busy: [
          { start: new Date('2026-06-15T15:00:00Z'), end: new Date('2026-06-15T16:00:00Z') },
        ],
      }),
    );

    for (const block of first.blocks) {
      const match = second.blocks.find(
        (candidate) =>
          candidate.taskId === block.taskId && candidate.chunkIndex === block.chunkIndex,
      );
      expect(match, `block for ${block.taskId} disappeared`).toBeDefined();
      expect(match!.start.getTime(), `block for ${block.taskId} moved`).toBe(block.start.getTime());
    }
  });

  it('moves only what the conflict actually displaces', () => {
    const tasks = [
      makeTask({ id: 'a', remainingMinutes: 60 }),
      makeTask({ id: 'b', remainingMinutes: 60 }),
      makeTask({ id: 'c', remainingMinutes: 60 }),
    ];

    const first = plan(makeInput({ tasks }));
    const firstBlock = [...first.blocks].sort((x, y) => x.start.getTime() - y.start.getTime())[0]!;

    // Drop a meeting directly on top of the very first block.
    const second = plan(
      makeInput({
        tasks,
        previous: first.blocks,
        busy: [{ start: firstBlock.start, end: firstBlock.end }],
      }),
    );

    const moved = first.blocks.filter((block) => {
      const match = second.blocks.find(
        (candidate) =>
          candidate.taskId === block.taskId && candidate.chunkIndex === block.chunkIndex,
      );
      return !match || match.start.getTime() !== block.start.getTime();
    });

    // Exactly the displaced block moves; the rest stay put.
    expect(moved).toHaveLength(1);
    expect(moved[0]!.taskId).toBe(firstBlock.taskId);
  });

  it('is deterministic — identical input yields an identical plan', () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      makeTask({ id: `t${index}`, remainingMinutes: 45 }),
    );

    const a = plan(makeInput({ tasks }));
    const b = plan(makeInput({ tasks: [...tasks].reverse() }));

    // Input order must not change the outcome, or every replan produces a
    // meaningless diff.
    expect(a.blocks.map((block) => `${block.taskId}@${block.start.toISOString()}`)).toEqual(
      b.blocks.map((block) => `${block.taskId}@${block.start.toISOString()}`),
    );
  });
});

describe('capacity reporting', () => {
  it('reports a shortfall honestly rather than silently dropping work', () => {
    // 40 hours of work, one 8-hour day of horizon.
    const result = plan(
      makeInput({
        horizonDays: 1,
        tasks: Array.from({ length: 40 }, (_, index) =>
          makeTask({ id: `t${index}`, remainingMinutes: 60 }),
        ),
      }),
    );

    expect(result.unscheduled.length).toBeGreaterThan(0);
    expect(result.stats.scheduledMinutes).toBeLessThanOrEqual(result.stats.availableMinutes);
    expect(result.stats.tasksUnscheduled).toBeGreaterThan(0);
  });

  it('reports available time from working hours only', () => {
    const result = plan(makeInput({ horizonDays: 1 }));
    // One weekday, 09:00-17:00, minus the hour before `now` is irrelevant since
    // the day has not started: a full 8 hours.
    expect(result.stats.availableMinutes).toBe(480);
  });
});

describe('daylight saving', () => {
  it('keeps working hours at the right local time across a DST change', () => {
    // London clocks go forward on 2026-03-29.
    const before = plan(
      makeInput({
        now: new Date('2026-03-26T08:00:00Z'), // Thursday, GMT
        timeZone: 'Europe/London',
        horizonDays: 1,
        tasks: [makeTask({ id: 'a', remainingMinutes: 60 })],
      }),
    );

    const after = plan(
      makeInput({
        now: new Date('2026-03-31T07:00:00Z'), // Tuesday, BST
        timeZone: 'Europe/London',
        horizonDays: 1,
        tasks: [makeTask({ id: 'a', remainingMinutes: 60 })],
      }),
    );

    // Both start at 09:00 *local*, which is a different UTC instant either side
    // of the transition.
    expect(hhmm(before.blocks[0]!.start)).toBe('09:00'); // GMT == UTC
    expect(hhmm(after.blocks[0]!.start)).toBe('08:00'); // BST == UTC+1
  });
});
