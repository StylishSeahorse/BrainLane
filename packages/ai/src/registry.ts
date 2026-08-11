/**
 * The provider catalog.
 *
 * Adding a provider is an entry in this file — no migration, no new adapter,
 * no branch in the calling code. That is possible because almost every vendor
 * now speaks the OpenAI chat-completions format, so the only things that
 * genuinely differ are the base URL, the auth header, and a couple of quirks.
 *
 * `protocol` is the wire format, not the brand. Two providers sharing a
 * protocol share an adapter, which is why OpenRouter, CometAPI, Groq, DeepSeek,
 * Together, Mistral and a self-hosted Ollama all cost one line each.
 *
 * Model IDs are deliberately NOT hardcoded. Providers add and retire models
 * constantly, and a stale baked-in list is worse than none — it sends people to
 * a model that 404s. Instead, providers that expose `GET /models` are queried
 * live, and the field stays free text so a brand-new model works the day it
 * ships.
 */

export type ProviderProtocol = 'anthropic' | 'openai-compatible';

export interface ProviderDefinition {
  /** Stable catalog key. Persisted on the user's settings row. */
  id: string;
  label: string;
  /** Which wire format, and therefore which adapter. */
  protocol: ProviderProtocol;
  /** Default endpoint. User-editable only when `editableBaseUrl`. */
  baseUrl: string;
  /** Whether the user must supply their own key. */
  requiresKey: boolean;
  /** Self-hosted endpoints are named by the user. */
  editableBaseUrl?: boolean;
  /** Permits http://localhost — local runtimes only. */
  allowLocalhost?: boolean;
  /** Provider exposes `GET /models`, so the picker can be populated live. */
  supportsModelListing?: boolean;
  /** Suggested starting model. Free text; never enforced. */
  defaultModel?: string;
  /** Where to get a key. Shown next to the key field. */
  keyUrl?: string;
  blurb: string;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    defaultModel: 'claude-opus-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude models, called natively.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'GPT models direct from OpenAI.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://openrouter.ai/keys',
    blurb: 'One key, hundreds of models across most vendors.',
  },
  {
    id: 'cometapi',
    label: 'CometAPI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.cometapi.com/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://api.cometapi.com',
    blurb: 'Aggregator exposing many vendors behind one OpenAI-style endpoint.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    protocol: 'openai-compatible',
    // Gemini ships an OpenAI-compatible surface, so it needs no adapter of its
    // own — one less wire format to maintain.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Gemini models via their OpenAI-compatible endpoint.',
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://console.groq.com/keys',
    blurb: 'Very fast inference for open models.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    blurb: 'Low-cost reasoning and chat models.',
  },
  {
    id: 'together',
    label: 'Together AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://api.together.ai/settings/api-keys',
    blurb: 'Hosted open-weight models.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    supportsModelListing: true,
    keyUrl: 'https://console.mistral.ai/api-keys',
    blurb: 'Mistral’s hosted models.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    // Nothing leaves the machine, so there is nothing to authenticate to.
    requiresKey: false,
    editableBaseUrl: true,
    allowLocalhost: true,
    supportsModelListing: true,
    blurb: 'Runs on your own machine. Nothing leaves it.',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    protocol: 'openai-compatible',
    baseUrl: '',
    requiresKey: false,
    editableBaseUrl: true,
    allowLocalhost: true,
    supportsModelListing: true,
    blurb: 'Any other OpenAI-compatible server, such as vLLM or LM Studio.',
  },
] as const;

export const DEFAULT_PROVIDER_ID = 'anthropic';

export function getProvider(id: string | null | undefined): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]!;
}

export function isKnownProvider(id: string): boolean {
  return PROVIDERS.some((provider) => provider.id === id);
}

/**
 * The endpoint to actually call.
 *
 * A user-supplied URL wins only where the catalog says it may; otherwise the
 * catalog value stands, so a stored value cannot silently redirect a
 * well-known provider somewhere else.
 */
export function resolveBaseUrl(
  provider: ProviderDefinition,
  storedBaseUrl: string | null | undefined,
): string {
  if (provider.editableBaseUrl && storedBaseUrl?.trim()) return storedBaseUrl.trim();
  return provider.baseUrl;
}
