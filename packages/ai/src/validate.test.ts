import type { SchedulableTask } from '@fluid/core';
import { describe, expect, it, vi } from 'vitest';
import { RefMap } from './redaction';
import { FakeAIProvider } from './testing/fake-provider';
import { applySuggestedOrder, validateScheduleSuggestion, withFallback } from './validate';

function makeTask(id: string): SchedulableTask {
  return {
    id,
    title: `Task ${id}`,
    remainingMinutes: 60,
    priority: 'MEDIUM',
    energy: 'MEDIUM',
    isSplittable: true,
    minChunkMinutes: 25,
    maxChunkMinutes: 90,
  };
}

describe('validateScheduleSuggestion', () => {
  it('accepts a well-formed proposal and keeps its ordering', () => {
    const refs = new RefMap();
    const tasks = [makeTask('a'), makeTask('b')];
    const refA = refs.ref('a');
    const refB = refs.ref('b');

    const result = validateScheduleSuggestion(
      {
        placements: [
          { ref: refB, startsInHours: 0, durationMinutes: 60, rationale: 'Due sooner' },
          { ref: refA, startsInHours: 2, durationMinutes: 60, rationale: 'Follows on' },
        ],
      },
      refs,
      tasks,
    );

    expect(result.usable).toBe(true);
    expect(result.orderedTaskIds).toEqual(['b', 'a']);
    expect(result.rationales.get('b')).toBe('Due sooner');
  });

  // The core containment property: an injected instruction cannot address rows
  // it was not given, because it never learns a real id.
  it('rejects references the model invented', () => {
    const refs = new RefMap();
    refs.ref('a');

    const result = validateScheduleSuggestion(
      {
        placements: [
          { ref: 'task_999', startsInHours: 0, durationMinutes: 60, rationale: 'x' },
          { ref: 'some-other-users-task-id', startsInHours: 0, durationMinutes: 60, rationale: 'x' },
        ],
      },
      refs,
      [makeTask('a')],
    );

    expect(result.usable).toBe(false);
    expect(result.orderedTaskIds).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]!.reason).toBe('unknown task reference');
  });

  it('rejects a task outside the current planning set', () => {
    const refs = new RefMap();
    const ref = refs.ref('not-in-set');

    const result = validateScheduleSuggestion(
      { placements: [{ ref, startsInHours: 0, durationMinutes: 60, rationale: 'x' }] },
      refs,
      [makeTask('a')],
    );

    expect(result.rejected[0]!.reason).toBe('task is not in the current planning set');
  });

  it('drops duplicate placements', () => {
    const refs = new RefMap();
    const ref = refs.ref('a');

    const result = validateScheduleSuggestion(
      {
        placements: [
          { ref, startsInHours: 0, durationMinutes: 60, rationale: 'first' },
          { ref, startsInHours: 4, durationMinutes: 60, rationale: 'again' },
        ],
      },
      refs,
      [makeTask('a')],
    );

    expect(result.orderedTaskIds).toEqual(['a']);
    expect(result.rejected[0]!.reason).toBe('duplicate placement');
  });

  it('survives malformed output without throwing', () => {
    const refs = new RefMap();
    for (const junk of [
      {} as never,
      { placements: null } as never,
      { placements: 'not an array' } as never,
      { placements: [{ notARef: true }] } as never,
    ]) {
      expect(() => validateScheduleSuggestion(junk, refs, [])).not.toThrow();
      expect(validateScheduleSuggestion(junk, refs, []).usable).toBe(false);
    }
  });

  it('strips markup from rationales before they reach the UI', () => {
    const refs = new RefMap();
    const ref = refs.ref('a');

    const result = validateScheduleSuggestion(
      {
        placements: [
          {
            ref,
            startsInHours: 0,
            durationMinutes: 60,
            rationale: '<img src=x onerror=alert(1)> do this first',
          },
        ],
      },
      refs,
      [makeTask('a')],
    );

    expect(result.rationales.get('a')).not.toContain('<');
    expect(result.rationales.get('a')).not.toContain('>');
  });

  it('bounds rationale length', () => {
    const refs = new RefMap();
    const ref = refs.ref('a');

    const result = validateScheduleSuggestion(
      { placements: [{ ref, startsInHours: 0, durationMinutes: 60, rationale: 'x'.repeat(5000) }] },
      refs,
      [makeTask('a')],
    );

    expect(result.rationales.get('a')!.length).toBeLessThanOrEqual(240);
  });

  it('takes no timing information from the model at all', () => {
    const refs = new RefMap();
    const ref = refs.ref('a');

    const result = validateScheduleSuggestion(
      {
        placements: [
          // A proposal at 3am, for 48 hours, on a protected day. None of it
          // survives: only ordering is extracted.
          { ref, startsInHours: -500, durationMinutes: 99999, rationale: 'trust me' },
        ],
      },
      refs,
      [makeTask('a')],
    );

    expect(result.orderedTaskIds).toEqual(['a']);
    expect(JSON.stringify([...result.rationales])).not.toContain('99999');
    expect(Object.keys(result)).not.toContain('placements');
  });
});

describe('applySuggestedOrder', () => {
  it('reorders mentioned tasks and appends the rest', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const ordered = applySuggestedOrder(tasks, ['c', 'a']);
    expect(ordered.map((task) => task.id)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for an empty suggestion', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    expect(applySuggestedOrder(tasks, []).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

// The app must never be blocked by a model. These are the paths that guarantee
// it, including for a user who has turned AI off entirely.
describe('withFallback', () => {
  it('uses the AI result when the call succeeds', async () => {
    const result = await withFallback(
      async () => 'from-ai',
      () => 'deterministic',
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ value: 'from-ai', usedAi: true });
  });

  it('falls back when the provider errors', async () => {
    const onError = vi.fn();
    const result = await withFallback(
      async () => {
        throw new Error('provider exploded');
      },
      () => 'deterministic',
      { timeoutMs: 1000, onError },
    );

    expect(result).toEqual({ value: 'deterministic', usedAi: false });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('falls back when the provider hangs', async () => {
    const provider = new FakeAIProvider({ hang: true });

    const result = await withFallback(
      () => provider.breakdownTask({ title: 'x', estimatedMinutes: 30, granularity: 'tiny' }),
      () => [],
      { timeoutMs: 50 },
    );

    expect(result.usedAi).toBe(false);
    expect(result.value).toEqual([]);
  });

  it('reports usedAi honestly, so the UI can say which engine ran', async () => {
    const provider = new FakeAIProvider({ failWith: 'unavailable' });
    const fallbackSubtasks = [
      { title: 'Spend five minutes on it', estimatedMinutes: 5, isStarterStep: true },
    ];

    const failing = await withFallback(
      () => provider.breakdownTask({ title: 'x', estimatedMinutes: 30, granularity: 'tiny' }),
      () => fallbackSubtasks,
      { timeoutMs: 100 },
    );

    expect(failing.usedAi).toBe(false);
    expect(failing.value).toEqual(fallbackSubtasks);

    const working = await withFallback(
      () => new FakeAIProvider().breakdownTask({
        title: 'x',
        estimatedMinutes: 30,
        granularity: 'tiny',
      }),
      () => fallbackSubtasks,
      { timeoutMs: 1000 },
    );

    expect(working.usedAi).toBe(true);
    expect(working.value).not.toEqual(fallbackSubtasks);
  });

  it('does not leave a dangling timer after a fast success', async () => {
    // A leaked timer keeps a worker process alive and makes jobs look hung.
    const before = process.getActiveResourcesInfo?.().length ?? 0;
    await withFallback(
      async () => 'quick',
      () => 'fallback',
      { timeoutMs: 30_000 },
    );
    const after = process.getActiveResourcesInfo?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});
