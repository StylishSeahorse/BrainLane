/**
 * One adapter for every OpenAI-compatible provider.
 *
 * OpenAI, OpenRouter, CometAPI, Gemini's compat endpoint, Groq, DeepSeek,
 * Together, Mistral, Ollama and anything self-hosted all accept the same
 * `POST /chat/completions` shape. Writing an adapter per brand would be nine
 * copies of one file, each drifting independently — so the differences that
 * genuinely exist (base URL, auth header, whether JSON mode is honoured) are
 * data, and this is the only code.
 *
 * Every request goes through `pinnedFetch`, so a user-supplied endpoint cannot
 * be used to reach the cloud metadata service or anything else on the private
 * network.
 */
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
import { assertSafeEndpoint, pinnedFetch, UnsafeEndpointError } from '../net/safe-url';

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Reasoning intent mapped to sampling temperature.
 *
 * The neutral `PromptSpec` speaks in intent because vendors disagree on the
 * knob — Anthropic removed sampling parameters entirely, while these providers
 * still expect a temperature. Translating here is exactly the adapter's job.
 */
const TEMPERATURE_BY_REASONING = {
  minimal: 0,
  normal: 0.3,
  deep: 0.7,
} as const;

export interface OpenAICompatibleOptions {
  providerId: string;
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  timeoutMs?: number;
  allowLocalhost?: boolean;
  /** Sent by OpenRouter-style aggregators for attribution. Optional. */
  appUrl?: string | undefined;
}

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string; type?: string };
}

export class OpenAICompatibleAdapter implements AIProvider {
  readonly kind = 'OPENAI' as const;
  readonly model: string;
  readonly providerId: string;

  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly allowLocalhost: boolean;
  private readonly appUrl: string | undefined;

  constructor(options: OpenAICompatibleOptions) {
    this.providerId = options.providerId;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowLocalhost = options.allowLocalhost ?? false;
    this.appUrl = options.appUrl;

    // Validated at construction, so an unsafe endpoint fails before any prompt
    // is built rather than at the moment of the outbound request.
    this.baseUrl = assertSafeEndpoint(options.baseUrl, {
      allowLocalhost: this.allowLocalhost,
    });
  }

  // -------------------------------------------------------------------------
  // Feature methods — identical in shape to the Anthropic adapter, because
  // both satisfy the same interface. Callers cannot tell them apart.
  // -------------------------------------------------------------------------

  async generateScheduleSuggestion(context: SchedulingContext): Promise<ScheduleSuggestion> {
    const parsed = await this.runStructured<ScheduleSuggestion>(schedulingPrompt(context));
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

  async chatRespond(messages: PromptMessage[], context: SchedulingContext): Promise<PromptMessage> {
    const text = await this.runText(chatPrompt(messages, context));
    return { role: 'assistant', content: text };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.send({
        system: 'Reply with the single word OK.',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        maxOutputTokens: 16,
        reasoning: 'minimal',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List the models this endpoint actually serves.
   *
   * This is why no model IDs are hardcoded anywhere: vendors add and retire
   * models weekly, and asking the provider is both accurate and permanently
   * current.
   */
  async listModels(): Promise<string[]> {
    const response = await this.request('/models', { method: 'GET' });
    const body = (await response.json()) as { data?: Array<{ id?: string }> };

    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    // Local runtimes such as Ollama accept no key at all; sending an empty
    // Authorization header makes some of them 401.
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    // OpenRouter-style aggregators use these for attribution and rankings.
    if (this.providerId === 'openrouter' && this.appUrl) {
      headers['http-referer'] = this.appUrl;
      headers['x-title'] = 'Fluid';
    }

    return headers;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(
      `${this.baseUrl.pathname.replace(/\/$/, '')}${path}`,
      this.baseUrl.origin,
    );

    let response: Response;
    try {
      response = await pinnedFetch(
        url,
        { ...init, headers: this.headers(), timeoutMs: this.timeoutMs },
        { allowLocalhost: this.allowLocalhost },
      );
    } catch (error) {
      throw translateTransportError(error, this.timeoutMs);
    }

    if (!response.ok) throw await translateHttpError(response);
    return response;
  }

  private async send(spec: PromptSpec): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: spec.system },
        ...spec.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      max_tokens: spec.maxOutputTokens ?? 4096,
      temperature: TEMPERATURE_BY_REASONING[spec.reasoning ?? 'normal'],
    };

    // JSON mode where a schema was requested. Support is uneven across
    // providers, so the parser below never assumes it worked.
    if (spec.outputSchema) body.response_format = { type: 'json_object' };

    const response = await this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return (await response.json()) as ChatResponse;
  }

  private async runText(spec: PromptSpec): Promise<string> {
    const payload = await this.send(spec);

    if (payload.error?.message) throw new AIResponseError(payload.error.message);

    const choice = payload.choices?.[0];

    // Some providers signal a policy refusal through finish_reason rather than
    // an error, and return empty content. Treat it as a handleable outcome so
    // the deterministic path takes over instead of a confusing parse failure.
    if (choice?.finish_reason === 'content_filter') {
      throw new AIResponseError(
        'The model declined this request. The deterministic planner will run instead.',
      );
    }

    const text = choice?.message?.content?.trim();
    if (!text) throw new AIResponseError('Model returned no content');
    return text;
  }

  private async runStructured<T>(spec: PromptSpec): Promise<T> {
    const text = await this.runText(spec);

    try {
      return JSON.parse(extractJson(text)) as T;
    } catch {
      throw new AIResponseError('Model response was not valid JSON');
    }
  }
}

/**
 * Pull the JSON object out of a reply.
 *
 * Providers that ignore `response_format` wrap JSON in prose or a ```json
 * fence. Being lenient here is the difference between "works everywhere" and
 * "works only on OpenAI", and the result is validated downstream regardless.
 */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) return candidate.slice(start, end + 1);

  return candidate;
}

function clampMinutes(value: unknown): number {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 15;
  return Math.min(480, Math.max(5, minutes));
}

function translateTransportError(error: unknown, timeoutMs: number): Error {
  if (error instanceof UnsafeEndpointError) {
    // Not retryable and not the provider's fault — the endpoint itself is
    // refused, so say so plainly rather than reporting an outage.
    return new AIResponseError(error.message);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new AITimeoutError(timeoutMs);
  }
  return new AIUnavailableError('Could not reach the AI provider.');
}

async function translateHttpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    // Non-JSON error bodies are common on gateways and proxies.
  }

  if (response.status === 401 || response.status === 403) {
    return new AIAuthError(detail || 'The provider rejected the API key.');
  }
  if (response.status === 429) {
    return new AIUnavailableError(detail || 'The provider is rate limiting; falling back.');
  }
  if (response.status >= 500) {
    return new AIUnavailableError(detail || `Provider error (${response.status}).`);
  }
  return new AIResponseError(detail || `Provider rejected the request (${response.status}).`);
}
