import { describe, expect, it } from 'vitest';
import {
  planActions,
  validateAction,
  type ActionContext,
  type AutonomyLevel,
  type CalendarAction,
  type OwnedBlock,
} from './index';

/** 2026-06-15 is a Monday. Working hours 09:00–17:00, lunch 12:30–13:30. */
const NOW = new Date('2026-06-15T08:00:00Z');
const at = (hour: number, minute = 0, dayOffset = 0) =>
  new Date(Date.UTC(2026, 5, 15 + dayOffset, hour, minute, 0, 0));

const ownedBlock = (overrides: Partial<OwnedBlock> = {}): OwnedBlock => ({
  blockId: 'block-1',
  taskId: 'task-1',
  start: at(9),
  end: at(10),
  isPinned: false,
  ...overrides,
});

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    now: NOW,
    timeZone: 'UTC',
    scope: 'THIS_WEEK',
    workingHours: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      dayOfWeek,
      startTime: '09:00',
      endTime: '17:00',
    })),
    protectedTimes: [
      { kind: 'ROUTINE', label: 'Lunch', dayOfWeek: null, startTime: '12:30', endTime: '13:30' },
    ],
    external: [],
    ownedBlocks: [ownedBlock()],
    ...overrides,
  };
}

describe('ownership — the AI may only touch what it created', () => {
  it('refuses to move a block it does not own', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'someone-elses-meeting', start: at(14), end: at(15), reason: 'x' },
      makeContext(),
    );

    expect(verdict.decision).toBe('REFUSE');
    expect(verdict).toMatchObject({ boundary: 'NOT_OWNED' });
  });

  it('refuses to move a block the user pinned by hand', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(14), end: at(15), reason: 'x' },
      makeContext({ ownedBlocks: [ownedBlock({ isPinned: true })] }),
    );

    expect(verdict).toMatchObject({ decision: 'REFUSE', boundary: 'PINNED' });
  });

  it('allows moving a block it owns to a free, in-hours slot', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(14), end: at(15), reason: 'x' },
      makeContext(),
    );
    expect(verdict.decision).toBe('ALLOW');
  });
});

// Protected time is the one category that exists specifically to be defended
// from the scheduler.
describe('protected time is inviolable', () => {
  it('refuses to schedule over a protected block', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(12, 30), end: at(13, 30), reason: 'x' },
      makeContext(),
    );
    expect(verdict).toMatchObject({ decision: 'REFUSE', boundary: 'PROTECTED_TIME' });
  });

  it('refuses even partial overlap', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(12), end: at(13), reason: 'x' },
      makeContext(),
    );
    expect(verdict).toMatchObject({ decision: 'REFUSE', boundary: 'PROTECTED_TIME' });
  });

  it('refuses regardless of autonomy level — full auto does not override it', () => {
    for (const autonomy of ['FULL_AUTO', 'AUTO_WITH_UNDO', 'PROPOSE_THEN_CONFIRM'] as AutonomyLevel[]) {
      const { outcomes } = planActions(
        [{ type: 'MOVE_BLOCK', blockId: 'block-1', start: at(12, 30), end: at(13), reason: 'x' }],
        makeContext(),
        autonomy,
      );
      expect(outcomes[0]!.disposition, autonomy).toBe('BLOCKED');
    }
  });
});

describe('hard boundaries always reach a human', () => {
  it('never deletes unattended, even on full auto', () => {
    const { outcomes } = planActions(
      [{ type: 'DELETE_BLOCK', blockId: 'block-1', reason: 'no longer needed' }],
      makeContext(),
      'FULL_AUTO',
    );

    expect(outcomes[0]!.verdict).toMatchObject({
      decision: 'NEEDS_CONFIRMATION',
      boundary: 'DELETION',
    });
    // The point of the test: FULL_AUTO does not mean "delete without asking".
    expect(outcomes[0]!.disposition).toBe('PROPOSE');
  });

  it('asks before scheduling outside working hours', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(20), end: at(21), reason: 'x' },
      makeContext(),
    );
    expect(verdict).toMatchObject({
      decision: 'NEEDS_CONFIRMATION',
      boundary: 'OUTSIDE_WORKING_HOURS',
    });
  });

  it('asks before double-booking over an external meeting', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(14), end: at(15), reason: 'x' },
      makeContext({ external: [{ start: at(14), end: at(15) }] }),
    );
    expect(verdict).toMatchObject({ decision: 'NEEDS_CONFIRMATION', boundary: 'DOUBLE_BOOKING' });
  });

  it('asks before stacking two of its own blocks', () => {
    const verdict = validateAction(
      { type: 'CREATE_BLOCK', taskId: 'task-2', start: at(9, 30), end: at(10, 30), reason: 'x' },
      makeContext(),
    );
    expect(verdict).toMatchObject({ decision: 'NEEDS_CONFIRMATION', boundary: 'DOUBLE_BOOKING' });
  });

  it('does not treat a block colliding with its own current position as a conflict', () => {
    // Resizing 09:00–10:00 out to 11:00 must not read as double-booking itself.
    const verdict = validateAction(
      { type: 'RESIZE_BLOCK', blockId: 'block-1', end: at(11), reason: 'ran over' },
      makeContext(),
    );
    expect(verdict.decision).toBe('ALLOW');
  });
});

describe('blast radius', () => {
  it('refuses to reach beyond today when the scope is today', () => {
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(9, 0, 3), end: at(10, 0, 3), reason: 'x' },
      makeContext({ scope: 'TODAY' }),
    );
    expect(verdict).toMatchObject({ decision: 'REFUSE', boundary: 'OUTSIDE_SCOPE' });
  });

  it('refuses to move a block that currently sits outside the scope', () => {
    // Reaching *into* the window from outside it is the same overreach.
    const verdict = validateAction(
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(14), end: at(15), reason: 'x' },
      makeContext({
        scope: 'TODAY',
        ownedBlocks: [ownedBlock({ start: at(9, 0, 4), end: at(10, 0, 4) })],
      }),
    );
    expect(verdict).toMatchObject({ decision: 'REFUSE', boundary: 'OUTSIDE_SCOPE' });
  });

  it('caps how many actions one pass may apply', () => {
    const actions: CalendarAction[] = Array.from({ length: 25 }, (_, index) => ({
      type: 'CREATE_BLOCK',
      taskId: `task-${index}`,
      start: at(14),
      end: at(15),
      reason: 'x',
    }));

    const { outcomes, droppedForLimit } = planActions(actions, makeContext(), 'FULL_AUTO', 20);
    expect(outcomes).toHaveLength(20);
    expect(droppedForLimit).toHaveLength(5);
  });
});

describe('autonomy levels', () => {
  const safeMove: CalendarAction = {
    type: 'MOVE_BLOCK',
    blockId: 'block-1',
    start: at(14),
    end: at(15),
    reason: 'making room for a call',
  };

  it('maps a safe action onto the level the user chose', () => {
    const expected: Record<AutonomyLevel, string> = {
      FULL_AUTO: 'EXECUTE',
      AUTO_WITH_UNDO: 'EXECUTE_WITH_UNDO',
      PROPOSE_THEN_CONFIRM: 'PROPOSE',
    };

    for (const [autonomy, disposition] of Object.entries(expected)) {
      const { outcomes } = planActions([safeMove], makeContext(), autonomy as AutonomyLevel);
      expect(outcomes[0]!.disposition, autonomy).toBe(disposition);
    }
  });

  it('writes nothing at all under propose-then-confirm', () => {
    const { outcomes } = planActions(
      [safeMove, { type: 'DELETE_BLOCK', blockId: 'block-1', reason: 'x' }],
      makeContext(),
      'PROPOSE_THEN_CONFIRM',
    );
    expect(outcomes.every((outcome) => outcome.disposition !== 'EXECUTE')).toBe(true);
  });
});

describe('explanations', () => {
  it('gives every refusal a reason a person can read', () => {
    const cases: CalendarAction[] = [
      { type: 'MOVE_BLOCK', blockId: 'unknown', start: at(14), end: at(15), reason: 'x' },
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(12, 30), end: at(13), reason: 'x' },
      { type: 'MOVE_BLOCK', blockId: 'block-1', start: at(20), end: at(21), reason: 'x' },
      { type: 'DELETE_BLOCK', blockId: 'block-1', reason: 'x' },
    ];

    for (const action of cases) {
      const verdict = validateAction(action, makeContext());
      expect(verdict.decision).not.toBe('ALLOW');
      if (verdict.decision !== 'ALLOW') {
        // A sentence, not a constraint code.
        expect(verdict.explanation.length).toBeGreaterThan(20);
        expect(verdict.explanation).toMatch(/\s/);
      }
    }
  });
});

describe('degenerate input', () => {
  it('refuses a zero-length or inverted range', () => {
    for (const end of [at(9), at(8)]) {
      const verdict = validateAction(
        { type: 'RESIZE_BLOCK', blockId: 'block-1', end, reason: 'x' },
        makeContext(),
      );
      expect(verdict).toMatchObject({ decision: 'REFUSE', boundary: 'INVALID_RANGE' });
    }
  });
});
