/**
 * The one seam where the AI is allowed to influence the calendar.
 *
 * Shared by both places that run the deterministic scheduler — the explicit
 * "Plan my week" proposal (`planning.ts`) and the autonomy-driven agent
 * (`calendar-agent.ts`) — so the rule lives in exactly one place: a model
 * proposal is a hint about *ordering*, never about time. See
 * `@fluid/ai`'s `validate.ts` for why — in short, verifying that a model
 * respected availability, protected time and existing meetings is exactly the
 * job the deterministic scheduler already does, so nothing is gained by
 * trusting the model's own times and a prompt-injected one could be wrong in
 * a way that is expensive to catch. Order, by contrast, can only ever affect
 * which legal slot a task gets — the scheduler still enforces every hard
 * constraint on the result.
 */
import 'server-only';
import type { SchedulableTask } from '@fluid/core';
import {
  DEFAULT_CONSENT,
  RefMap,
  applySuggestedOrder,
  newAudit,
  redactTask,
  validateScheduleSuggestion,
  withFallback,
  type ConsentFlags,
} from '@fluid/ai';
import { features } from '@fluid/env';
import type { Task } from '@fluid/db';
import { getAiProvider } from './ai-provider';

// A hosted API answers this in a second or two; a CLI provider spawns a real
// subprocess and can reasonably take 15-20s under load, since it is competing
// for the same CPU as everything else running locally. 20s cut it too close
// in practice — timing out on runs that would have succeeded a few seconds
// later — so this is set with headroom rather than to the observed minimum.
const AI_TIMEOUT_MS = 30_000;

export interface AiOrderingInput {
  userId: string;
  now: Date;
  timeZone: string;
  workingHoursCount: number;
  /** The scheduler's own task shape — what gets reordered. */
  tasks: SchedulableTask[];
  /** The same tasks as loaded from the database — what redaction reads from. */
  rawTasks: Task[];
  consent: ConsentFlags;
}

export interface AiOrderingResult {
  /** `input.tasks`, reordered — or unchanged if AI was unavailable, off, or unusable. */
  tasks: SchedulableTask[];
  usedAi: boolean;
  /** Per-task rationale from the model, for tasks whose order it influenced. */
  rationales: Map<string, string>;
}

const NONE: Omit<AiOrderingResult, 'tasks'> = { usedAi: false, rationales: new Map() };

/**
 * Ask the model which of these tasks it would tackle first, and fold that
 * preference into the order the deterministic scheduler runs against.
 *
 * Never throws and never blocks indefinitely — `withFallback` bounds the call
 * with a hard timeout, and any failure (timeout, malformed reply, a ref that
 * does not resolve) is treated identically to "no AI configured": the tasks
 * come back in their original order.
 */
export async function applyAiOrderingHint(input: AiOrderingInput): Promise<AiOrderingResult> {
  if (!features.ai || !input.consent.allowScheduling || input.tasks.length < 2) {
    return { tasks: input.tasks, ...NONE };
  }

  const provider = await getAiProvider(input.userId);
  if (!provider) return { tasks: input.tasks, ...NONE };

  const refs = new RefMap();
  const audit = newAudit();

  const context = {
    // `redactTask`'s declared return type widens `priority`/`energy` to
    // `string` even though it only ever echoes the enum values it was given;
    // the cast matches that, not a real type gap.
    taskRefs: input.rawTasks.map((task) =>
      redactTask(task, { consent: input.consent, refs, now: input.now, audit }),
    ) as never,
    // Left empty deliberately — see the module doc. The model is never told
    // what times are free, because it is never asked to name one.
    availableSlots: [],
    workingHoursPerWeek: input.workingHoursCount * 8,
    timeZone: input.timeZone,
  };

  const outcome = await withFallback(() => provider.generateScheduleSuggestion(context), () => null, {
    timeoutMs: AI_TIMEOUT_MS,
    // A failed AI call is a normal operating condition, not an incident.
    onError: (error) => console.warn('[ai-scheduler] AI unavailable, using deterministic order:', error),
  });

  if (!outcome.usedAi || !outcome.value) return { tasks: input.tasks, ...NONE };

  const validated = validateScheduleSuggestion(outcome.value, refs, input.tasks);
  if (!validated.usable) return { tasks: input.tasks, ...NONE };

  return {
    tasks: applySuggestedOrder(input.tasks, validated.orderedTaskIds),
    usedAi: true,
    rationales: validated.rationales,
  };
}

/** Consent from a stored `AiSetting` row, or the safe default when none exists yet. */
export function consentFrom(
  aiSetting: {
    shareTaskText: boolean;
    allowScheduling: boolean;
    allowTaskBreakdown: boolean;
    allowAvoidanceCheck: boolean;
    allowChat: boolean;
  } | null,
): ConsentFlags {
  return aiSetting
    ? {
        shareTaskText: aiSetting.shareTaskText,
        allowScheduling: aiSetting.allowScheduling,
        allowTaskBreakdown: aiSetting.allowTaskBreakdown,
        allowAvoidanceCheck: aiSetting.allowAvoidanceCheck,
        allowChat: aiSetting.allowChat,
      }
    : DEFAULT_CONSENT;
}
