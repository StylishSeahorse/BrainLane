/**
 * Anthropic adapter.
 *
 * The only vendor-specific file in the AI layer. Everything above it speaks
 * `PromptSpec` and gets back validated data; this module is where that becomes
 * a Messages API call.
 *
 * Three current-API details worth stating, because each one is a 400 or a
 * silent failure if you carry over an older pattern:
 *
 *   - Sampling parameters (`temperature`, `top_p`, `top_k`) are rejected by
 *     current models. `PromptSpec.reasoning` maps onto `output_config.effort`
 *     instead.
 *   - Structured output uses `output_config.format` with a JSON schema. The
 *     older `output_format` parameter and assistant-turn prefills are gone —
 *     a prefill returns a 400.
 *   - Thinking is on by default. We leave it on and control cost with `effort`
 *     rather than disabling it: disabling thinking can make the model emit a
 *     tool call as plain text or leak internal tags into the response.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  AIAuthError,
  AIResponseError,
  AITimeoutError,
  AIUnavailableError,
  type AIProvider,
  type AvoidanceHistory,
  type Insight,
  type PromptMessage,
  type PromptSpec,
  type ScheduleSuggestion,
  type SchedulingContext,
  type Subtask,
  type TaskBreakdownRequest,
} from '../provider';
import {
  avoidancePrompt,
  breakdownPrompt,
  chatPrompt,
  schedulingPrompt,
} from '../prompts/index';

/**
 * Default model.
 *
 * Opus 5 across the board rather than a cheaper model for "simple" calls:
 * every one of these features is a judgement call about someone's week, and
 * the volume is a handful of calls per user per day. Users can override this
 * per-account in settings.
 */
const DEFAULT_MODEL = 'claude-opus-5';

/** The SDK's timeout is in milliseconds — seconds here would be a 10ms cap. */
const DEFAULT_TIMEOUT_MS = 30_000;

const EFFORT_BY_REASONING = {
  minimal: 'low',
  normal: 'medium',
  deep: 'high',
} as const;

export interface AnthropicAdapterOptions {
  /**
   * Omit to use ambient credentials.
   *
   * With no key, the SDK resolves in its documented order: `ANTHROPIC_API_KEY`,
   * then `ANTHROPIC_AUTH_TOKEN`, then the OAuth profile written by
   * `ant auth login`. That last one is how someone signs in through a browser
   * instead of pasting a key.
   */
  apiKey?: string | undefined;
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real client. */
  client?: Anthropic;
}

export class AnthropicAdapter implements AIProvider {
  readonly kind = 'ANTHROPIC' as const;
  readonly model: string;

  private readonly client: Anthropic;

  constructor(options: AnthropicAdapterOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.client =
      options.client ??
      new Anthropic({
        // Spread rather than pass `undefined`: omitting the property entirely
        // is what lets the SDK fall through to `ANTHROPIC_AUTH_TOKEN` and the
        // `ant auth login` OAuth profile.
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // The caller already wraps every call in `withFallback`, which has its
        // own deadline. Two retries inside that budget is the useful maximum —
        // more just burns the deadline before the fallback can run.
        maxRetries: 2,
      });
  }

  // -------------------------------------------------------------------------
  // Feature methods
  // -------------------------------------------------------------------------

  async generateScheduleSuggestion(context: SchedulingContext): Promise<ScheduleSuggestion> {
    const parsed = await this.runStructured<ScheduleSuggestion>(schedulingPrompt(context));

    // Shape check only. The real validation — that these refs exist and that
    // the placement is legal — happens in `validateScheduleSuggestion`, which
    // runs against the deterministic scheduler.
    if (!Array.isArray(parsed?.placements)) {
      throw new AIResponseError('Schedule suggestion did not contain a placements array');
    }
    return parsed;
  }

  async breakdownTask(request: TaskBreakdownRequest): Promise<Subtask[]> {
    const parsed = await this.runStructured<{ subtasks: Subtask[] }>(breakdownPrompt(request));

    if (!Array.isArray(parsed?.subtasks)) {
      throw new AIResponseError('Task breakdown did not contain a subtasks array');
    }

    return parsed.subtasks
      .filter((subtask) => typeof subtask?.title === 'string' && subtask.title.trim())
      .map((subtask) => ({
        title: subtask.title.trim().slice(0, 200),
        estimatedMinutes: clampMinutes(subtask.estimatedMinutes),
        isStarterStep: Boolean(subtask.isStarterStep),
      }));
  }

  async detectAvoidancePattern(history: AvoidanceHistory): Promise<Insight[]> {
    const parsed = await this.runStructured<{ insights: Insight[] }>(avoidancePrompt(history));

    if (!Array.isArray(parsed?.insights)) return [];

    return parsed.insights.filter(
      (insight) => typeof insight?.ref === 'string' && typeof insight?.observation === 'string',
    );
  }

  async chatRespond(
    messages: PromptMessage[],
    context: SchedulingContext,
  ): Promise<PromptMessage> {
    const text = await this.runText(chatPrompt(messages, context));
    return { role: 'assistant', content: text };
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Smallest call that still proves credentials and reachability.
      await this.client.messages.create({
        model: this.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private buildRequest(spec: PromptSpec): Anthropic.MessageCreateParamsNonStreaming {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      // Bounded well below the model's ceiling: these are structured replies,
      // not essays, and a low cap makes a runaway response fail fast.
      max_tokens: spec.maxOutputTokens ?? 4096,
      system: spec.system,
      messages: spec.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };

    // Effort is how reasoning depth is expressed now. Note what is absent:
    // no `temperature`, no `top_p`, no `top_k` — current models reject them.
    const effort = EFFORT_BY_REASONING[spec.reasoning ?? 'normal'];

    const outputConfig: Record<string, unknown> = { effort };
    if (spec.outputSchema) {
      outputConfig.format = { type: 'json_schema', schema: spec.outputSchema };
    }

    // `output_config` is newer than the installed SDK's typings; the client
    // forwards unknown top-level keys unchanged, so this is a typing gap
    // rather than an unsupported parameter. Cast through `unknown` because
    // the params type has no index signature.
    (request as unknown as Record<string, unknown>).output_config = outputConfig;

    return request;
  }

  private async send(spec: PromptSpec): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create(this.buildRequest(spec));
    } catch (error) {
      throw translateError(error);
    }
  }

  private async runText(spec: PromptSpec): Promise<string> {
    const response = await this.send(spec);

    // Check the stop reason before touching content. A safety classifier can
    // decline a request and return HTTP 200 with an empty content array —
    // indexing content[0] blindly throws a confusing TypeError instead of a
    // handleable refusal.
    if (response.stop_reason === 'refusal') {
      throw new AIResponseError(
        'The model declined this request. Nothing was scheduled; the deterministic planner will run instead.',
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) throw new AIResponseError('Model returned no text content');
    return text;
  }

  private async runStructured<T>(spec: PromptSpec): Promise<T> {
    const text = await this.runText(spec);

    try {
      return JSON.parse(text) as T;
    } catch {
      // Structured output makes this rare, but a truncated response (hitting
      // max_tokens mid-object) still produces invalid JSON. Treat it as a
      // failed AI call so the deterministic path takes over, rather than
      // retrying into the same wall.
      throw new AIResponseError('Model response was not valid JSON');
    }
  }
}

function clampMinutes(value: unknown): number {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 15;
  return Math.min(480, Math.max(5, minutes));
}

/**
 * Map SDK errors onto our typed errors, so callers can tell "retry" from
 * "stop and tell the user".
 *
 * Note the ordering: `APIConnectionError` extends `APIError` in the TypeScript
 * SDK, so it has to be checked first or it would be swallowed by the more
 * general branch.
 */
function translateError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new AIAuthError('The AI provider rejected the API key.');
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new AIAuthError('This API key does not have access to the requested model.');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AIUnavailableError('The AI provider is rate limiting; falling back.');
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AITimeoutError(DEFAULT_TIMEOUT_MS);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AIUnavailableError('Could not reach the AI provider.');
  }
  if (error instanceof Anthropic.APIError) {
    return error.status && error.status >= 500
      ? new AIUnavailableError(`AI provider error (${error.status}).`)
      : new AIResponseError(`AI provider rejected the request (${error.status ?? 'unknown'}).`);
  }
  return error instanceof Error ? error : new AIUnavailableError(String(error));
}
