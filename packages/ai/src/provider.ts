/**
 * The AI provider interface.
 *
 * Two rules shape everything here, and both are security properties rather than
 * style preferences:
 *
 * 1. NO VENDOR SYNTAX ESCAPES THIS BOUNDARY. Business logic builds a neutral
 *    `PromptSpec`; each adapter translates it into its own dialect. Swapping
 *    Anthropic for a local Ollama model must not require touching a single line
 *    of scheduling code.
 *
 * 2. THE MODEL PROPOSES, IT NEVER ACTS. Every method returns data for the
 *    deterministic engine to validate. There are no side-effecting tools here —
 *    no "create the event", no "send the email". This is the containment for
 *    prompt injection, which is a live threat in this product: anyone who can
 *    send the user a meeting invite can put text into the model's input. The
 *    worst a successful injection achieves is a bad suggestion that the user
 *    sees in the diff and rejects.
 */
import type { EnergyLevel, Priority } from '@fluid/core';

// ---------------------------------------------------------------------------
// Neutral prompt representation
// ---------------------------------------------------------------------------

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A provider-agnostic request.
 *
 * `outputSchema` is a JSON Schema describing the expected reply. Adapters map
 * it onto whatever their provider offers — tool use, structured output modes,
 * or a plain instruction plus parsing — so callers get validated data back
 * regardless of which model answered.
 */
export interface PromptSpec {
  system: string;
  messages: PromptMessage[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /**
   * How much reasoning the task deserves, expressed as intent rather than as
   * any vendor's knob.
   *
   * Deliberately not `temperature`: current Anthropic models reject sampling
   * parameters outright, and a neutral interface that carries a field only one
   * vendor accepts is not neutral. Each adapter maps this onto whatever its
   * provider offers — effort levels, temperature, or nothing at all.
   */
  reasoning?: 'minimal' | 'normal' | 'deep';
}

// ---------------------------------------------------------------------------
// Feature payloads
// ---------------------------------------------------------------------------

/**
 * What the model is allowed to see when scheduling.
 *
 * Note what is missing: titles and notes. By default the model reasons over
 * durations, deadlines and coarse categories, and refers to tasks by opaque
 * reference. Users who want better suggestions can opt into sharing text
 * per-feature — but that is a decision they make, not a default they discover.
 */
export interface SchedulingContext {
  /** Opaque handle, e.g. "task_3". Maps back to a real id only on our side. */
  taskRefs: Array<{
    ref: string;
    /** Present only when the user has opted into sharing task text. */
    title?: string;
    estimatedMinutes: number;
    priority: Priority;
    energy: EnergyLevel;
    deadlineInDays?: number;
    category?: string;
    /** Times this task has already been pushed. Signals avoidance. */
    rescheduleCount: number;
  }>;
  availableSlots: Array<{ startsInHours: number; durationMinutes: number; energy: EnergyLevel }>;
  workingHoursPerWeek: number;
  timeZone: string;
}

export interface ScheduleSuggestion {
  placements: Array<{
    ref: string;
    /** Hours from now. Relative, so no absolute times need to be shared. */
    startsInHours: number;
    durationMinutes: number;
    /** Shown to the user beside the block. */
    rationale: string;
  }>;
  /** Model's own note about what it could not fit. */
  notes?: string;
}

export interface TaskBreakdownRequest {
  title: string;
  notes?: string;
  estimatedMinutes: number;
  /**
   * How small the first step should be. "tiny" produces the genuinely
   * frictionless entry point — "open the document and write one sentence" —
   * which is the whole point of the feature for a task that will not start.
   */
  granularity: 'tiny' | 'normal';
}

export interface Subtask {
  title: string;
  estimatedMinutes: number;
  /** True for the deliberately trivial opening move. */
  isStarterStep: boolean;
}

export interface AvoidanceHistory {
  tasks: Array<{
    ref: string;
    title?: string;
    rescheduleCount: number;
    daysSinceTouched: number;
    estimatedMinutes: number;
    hasDeadline: boolean;
  }>;
}

export interface Insight {
  ref: string;
  /**
   * Framing matters more than accuracy here. A correct observation delivered
   * as judgement produces shame, shame produces more avoidance, and the user
   * stops opening the app.
   */
  observation: string;
  suggestion: string;
  confidence: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface AIProvider {
  readonly kind: 'ANTHROPIC' | 'OPENAI' | 'GOOGLE' | 'LOCAL';
  readonly model: string;

  generateScheduleSuggestion(context: SchedulingContext): Promise<ScheduleSuggestion>;
  breakdownTask(request: TaskBreakdownRequest): Promise<Subtask[]>;
  detectAvoidancePattern(history: AvoidanceHistory): Promise<Insight[]>;
  chatRespond(messages: PromptMessage[], context: SchedulingContext): Promise<PromptMessage>;

  /** Cheap reachability check for the settings screen. */
  healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AIError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AIUnavailableError extends AIError {
  constructor(message = 'AI provider is unavailable') {
    super(message, true);
  }
}

export class AITimeoutError extends AIError {
  constructor(readonly timeoutMs: number) {
    super(`AI provider did not respond within ${timeoutMs}ms`, true);
  }
}

/** The model returned something that did not match the requested schema. */
export class AIResponseError extends AIError {
  constructor(message: string) {
    super(message, false);
  }
}

export class AIAuthError extends AIError {
  constructor(message = 'AI provider rejected the API key') {
    super(message, false);
  }
}
