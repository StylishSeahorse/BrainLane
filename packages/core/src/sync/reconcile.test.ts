import { describe, expect, it } from 'vitest';
import { reconcile, type LocalEvent, type RemoteChange } from './reconcile';

const at = (iso: string): Date => new Date(iso);

function local(overrides: Partial<LocalEvent> & { id: string }): LocalEvent {
  return {
    externalId: overrides.id,
    origin: 'EXTERNAL',
    startsAt: at('2026-06-15T09:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

const change = (externalId: string, isDeleted = false): RemoteChange => ({ externalId, isDeleted });

describe('ordinary changes', () => {
  it('writes through everything that is not a deletion', () => {
    const plan = reconcile({
      changes: [change('a'), change('b')],
      local: [],
      isFullSnapshot: false,
    });

    expect(plan.upserts).toHaveLength(2);
    expect(plan.tombstones).toEqual([]);
  });

  it('tombstones on an explicit deletion signal', () => {
    const plan = reconcile({
      changes: [change('a', true)],
      local: [local({ id: 'a' })],
      isFullSnapshot: false,
    });

    expect(plan.tombstones).toEqual(['a']);
    expect(plan.fromTombstoneSignal).toEqual(['a']);
  });

  it('ignores a deletion for something already gone locally', () => {
    const plan = reconcile({
      changes: [change('a', true)],
      local: [local({ id: 'a', deletedAt: at('2026-06-01T00:00:00Z') })],
      isFullSnapshot: false,
    });

    expect(plan.tombstones).toEqual([]);
  });
});

describe('absence', () => {
  it('is never a deletion in a delta', () => {
    // The single most important assertion here. A delta lists what changed;
    // everything else is simply not in it, and reading that as deletion is how
    // a partial response wipes a calendar.
    const plan = reconcile({
      changes: [change('a')],
      local: [local({ id: 'a' }), local({ id: 'b' }), local({ id: 'c' })],
      isFullSnapshot: false,
    });

    expect(plan.tombstones).toEqual([]);
    expect(plan.circuitBroken).toBe(false);
  });

  it('is a deletion in a complete snapshot', () => {
    const plan = reconcile({
      changes: [change('a'), change('b'), change('c'), change('d'), change('e')],
      local: [
        local({ id: 'a' }),
        local({ id: 'b' }),
        local({ id: 'c' }),
        local({ id: 'd' }),
        local({ id: 'e' }),
        local({ id: 'gone' }),
      ],
      isFullSnapshot: true,
    });

    expect(plan.fromAbsence).toEqual(['gone']);
  });

  it('never touches events outside the window a snapshot covered', () => {
    // A CalDAV calendar-query is always time-bounded. Everything outside the
    // range was not looked at, so it cannot be missing from the answer.
    const plan = reconcile({
      changes: [change('inside')],
      local: [
        local({ id: 'inside', startsAt: at('2026-06-15T09:00:00Z') }),
        local({ id: 'long-ago', startsAt: at('2019-01-01T09:00:00Z') }),
        local({ id: 'far-off', startsAt: at('2031-01-01T09:00:00Z') }),
      ],
      isFullSnapshot: true,
      snapshotWindow: { from: at('2026-03-01T00:00:00Z'), to: at('2027-06-01T00:00:00Z') },
    });

    expect(plan.tombstones).toEqual([]);
    expect(plan.examined).toBe(1);
  });

  it('never deletes our own blocks for being absent', () => {
    // An app block that has not been pushed yet is absent from every provider
    // listing. Deleting it on that basis would erase the user's schedule the
    // moment they connected a calendar.
    const plan = reconcile({
      changes: [],
      local: [
        local({ id: 'mine-1', origin: 'APP_BLOCK', externalId: null }),
        local({ id: 'mine-2', origin: 'APP_BLOCK', externalId: null }),
        local({ id: 'mine-3', origin: 'APP_BLOCK', externalId: null }),
        local({ id: 'mine-4', origin: 'APP_BLOCK', externalId: null }),
      ],
      isFullSnapshot: true,
    });

    expect(plan.tombstones).toEqual([]);
    expect(plan.circuitBroken).toBe(false);
  });

  it('accepts a couple of deletions without fuss', () => {
    // Two events removed out of twenty is a person tidying up, not a fault.
    const many = Array.from({ length: 20 }, (_, index) => local({ id: `e${index}` }));
    const plan = reconcile({
      changes: many.slice(2).map((event) => change(event.id)),
      local: many,
      isFullSnapshot: true,
    });

    expect(plan.circuitBroken).toBe(false);
    expect(plan.fromAbsence).toEqual(['e0', 'e1']);
  });
});

describe('the circuit breaker', () => {
  it('halts when a large share of a calendar disappears', () => {
    const many = Array.from({ length: 20 }, (_, index) => local({ id: `e${index}` }));
    const plan = reconcile({
      changes: many.slice(10).map((event) => change(event.id)),
      local: many,
      isFullSnapshot: true,
    });

    expect(plan.circuitBroken).toBe(true);
    // Nothing at all is written — not even the events that were present. A
    // sync we do not trust is not a sync we half-apply.
    expect(plan.upserts).toEqual([]);
    expect(plan.tombstones).toEqual([]);
    expect(plan.reason).toMatch(/50%/);
  });

  it('explains itself without jargon', () => {
    const many = Array.from({ length: 10 }, (_, index) => local({ id: `e${index}` }));
    const plan = reconcile({ changes: [], local: many, isFullSnapshot: true });

    expect(plan.reason).toBeDefined();
    expect(plan.reason).not.toMatch(/circuit|threshold|reconcil/i);
  });

  it('does not fire on explicit tombstones, however many', () => {
    // A provider stating fifty deletions is reporting something it knows.
    // Refusing to believe it would leave the calendar permanently wrong.
    const many = Array.from({ length: 50 }, (_, index) => local({ id: `e${index}` }));
    const plan = reconcile({
      changes: many.map((event) => change(event.id, true)),
      local: many,
      isFullSnapshot: false,
    });

    expect(plan.circuitBroken).toBe(false);
    expect(plan.tombstones).toHaveLength(50);
  });

  it('does not fire on an empty calendar’s first sync', () => {
    expect(reconcile({ changes: [], local: [], isFullSnapshot: true }).circuitBroken).toBe(false);
  });

  it('does not fire when a small calendar loses one event', () => {
    const plan = reconcile({
      changes: [change('a'), change('b')],
      local: [local({ id: 'a' }), local({ id: 'b' }), local({ id: 'c' })],
      isFullSnapshot: true,
    });

    expect(plan.circuitBroken).toBe(false);
    expect(plan.fromAbsence).toEqual(['c']);
  });
});
