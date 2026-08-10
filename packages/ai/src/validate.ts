/**
 * Validating what the model proposed.
 *
 * This is the containment boundary for prompt injection, and the reason the
 * feature can be offered at all. Calendar event descriptions are attacker-
 * controlled text: anyone who can send the user a meeting invite can put
 * instructions where the model will read them.
 *
 * So a proposal is treated as a hint about *ordering and grouping*, never as an
 * authority on where time exists. Every placement is re-derived against the
 * real availability by the deterministic scheduler. A proposal that overlaps
 * protected time, double-books a meeting, or names a task that does not exist
 * is discarded here, before it can reach a calendar.
 */
import type { SchedulableTask } from '@fluid/core';
import type { RefMap } from './redaction';
import type { ScheduleSuggestion } from './provider';

export interface ValidationResult {
  /**
   * Task ids in the order the model suggested working on them. This is the only
   * thing we take from a proposal — the scheduler decides the actual times.
   */
  orderedTaskIds: string[];
  /** Per-task rationale, shown beside the block if the placement survives. */
  rationales: Map<string, string>;
  /** Everything rejected, with the reason. Surfaced in the plan detail view. */
  rejected: Array<{ ref: string; reason: string }>;
  /** True if anything at all was usable. */
  usable: boolean;
}

const MAX_RATIONALE_LENGTH = 240;

/**
 * Reduce a model proposal to the narrow slice we are willing to act on.
 *
 * Note what is deliberately *not* extracted: the suggested start times. Letting
 * a model choose absolute times would mean trusting it to have respected
 * availability, protected time and existing meetings — none of which we can
 * verify cheaply, and all of which the deterministic scheduler already knows.
 * Taking only the ordering keeps the useful judgement (what to do first, what
 * to group together) and discards the part that could cause harm.
 */
export function validateScheduleSuggestion(
  suggestion: ScheduleSuggestion,
  refs: RefMap,
  knownTasks: SchedulableTask[],
): ValidationResult {
  const knownIds = new Set(knownTasks.map((task) => task.id));
  const orderedTaskIds: string[] = [];
  const rationales = new Map<string, string>();
  const rejected: Array<{ ref: string; reason: string }> = [];
  const seen = new Set<string>();

  if (!Array.isArray(suggestion?.placements)) {
    return { orderedTaskIds: [], rationales, rejected, usable: false };
  }

  for (const placement of suggestion.placements) {
    if (typeof placement?.ref !== 'string') {
      rejected.push({ ref: String(placement?.ref ?? 'unknown'), reason: 'malformed placement' });
      continue;
    }

    // A ref the model invented resolves to nothing. This is why opaque refs are
    // used rather than real ids: a hallucinated or injected identifier fails
    // closed instead of addressing some arbitrary row.
    const taskId = refs.resolve(placement.ref);
    if (!taskId) {
      rejected.push({ ref: placement.ref, reason: 'unknown task reference' });
      continue;
    }

    if (!knownIds.has(taskId)) {
      rejected.push({ ref: placement.ref, reason: 'task is not in the current planning set' });
      continue;
    }

    if (seen.has(taskId)) {
      rejected.push({ ref: placement.ref, reason: 'duplicate placement' });
      continue;
    }

    seen.add(taskId);
    orderedTaskIds.push(taskId);

    if (typeof placement.rationale === 'string' && placement.rationale.trim()) {
      // Model output is displayed to the user, so it is bounded and stripped of
      // anything that could render as markup.
      rationales.set(
        taskId,
        placement.rationale.replace(/[<>]/g, '').trim().slice(0, MAX_RATIONALE_LENGTH),
      );
    }
  }

  return { orderedTaskIds, rationales, rejected, usable: orderedTaskIds.length > 0 };
}

/**
 * Reorder tasks to match a validated suggestion.
 *
 * Tasks the model did not mention keep their deterministic ordering and follow
 * the ones it did. The scheduler then applies every hard constraint to the
 * result, so this can only ever influence preference, never legality.
 */
export function applySuggestedOrder(
  tasks: SchedulableTask[],
  orderedTaskIds: string[],
): SchedulableTask[] {
  const rank = new Map(orderedTaskIds.map((id, index) => [id, index]));
  return [...tasks].sort((a, b) => {
    const rankA = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });
}

/**
 * Run an AI call with a hard timeout and a deterministic fallback.
 *
 * The app must never block on a model. Whatever happens — timeout, outage,
 * rate limit, a user who has turned AI off entirely — the deterministic path
 * produces a schedule. `usedAi` is threaded through to the UI so the user is
 * told which one they are looking at rather than left to guess.
 */
export async function withFallback<T>(
  attempt: () => Promise<T>,
  fallback: () => T,
  options: { timeoutMs: number; onError?: (error: unknown) => void },
): Promise<{ value: T; usedAi: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`AI call exceeded ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });

    const value = await Promise.race([attempt(), timeout]);
    return { value, usedAi: true };
  } catch (error) {
    options.onError?.(error);
    return { value: fallback(), usedAi: false };
  } finally {
    // Without this the timer keeps the process alive after a fast success —
    // which in a worker means jobs that appear to hang.
    if (timer) clearTimeout(timer);
  }
}
