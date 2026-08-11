/**
 * Turns a stored AI setting into a live provider.
 *
 * Two rules decide the key: a user's own key always wins over the server's, so
 * "bring your own key" means their traffic and their bill; and returning `null`
 * is a first-class outcome, because every caller already handles the
 * deterministic path. "No AI configured" therefore needs no special case
 * anywhere upstream.
 */
import 'server-only';
import { env, features } from '@fluid/env';
import { prisma } from '@fluid/db';
import { openSecret, sealSecret } from '@fluid/crypto';
import { getProvider, resolveBaseUrl, type AIProvider, type ProviderDefinition } from '@fluid/ai';
import { AnthropicAdapter } from '@fluid/ai/adapters/anthropic';
import { OpenAICompatibleAdapter } from '@fluid/ai/adapters/openai-compatible';

const KEY_PURPOSE = 'ai-api-key';

/** Decrypt a stored key, tolerating a key that will not open. */
function decryptKey(userId: string, encrypted: string | null): string | undefined {
  if (!encrypted) return undefined;
  try {
    return openSecret(encrypted, { userId, purpose: KEY_PURPOSE });
  } catch (error) {
    // A key that will not decrypt is a real problem, but not one worth failing
    // someone's whole schedule over — fall through to the server key, and
    // ultimately to the deterministic scheduler.
    console.error('[ai] could not decrypt stored API key for user', userId, error);
    return undefined;
  }
}

export function encryptApiKey(userId: string, plaintext: string): string {
  return sealSecret(plaintext, { userId, purpose: KEY_PURPOSE });
}

export interface ResolvedProviderConfig {
  definition: ProviderDefinition;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
}

/**
 * Work out what would be called, without constructing anything.
 *
 * Shared by the factory and by "test connection", so the settings screen
 * exercises exactly the configuration the scheduler will use rather than an
 * approximation of it.
 */
export async function resolveConfig(userId: string): Promise<ResolvedProviderConfig | null> {
  const setting = await prisma.aiSetting.findUnique({ where: { userId } });
  const definition = getProvider(setting?.providerId);

  const apiKey =
    decryptKey(userId, setting?.encryptedApiKey ?? null) ??
    // The server key is Anthropic's; offering it to a third-party endpoint
    // would leak our credential to whatever host the user typed.
    (definition.id === 'anthropic' ? env.ANTHROPIC_API_KEY : undefined);

  if (definition.requiresKey && !apiKey) return null;

  const baseUrl = resolveBaseUrl(definition, setting?.baseUrl);
  if (!baseUrl) return null;

  const model = setting?.model?.trim() || definition.defaultModel;
  if (!model) return null;

  return { definition, baseUrl, model, apiKey };
}

/** Build a provider from a resolved config. Throws if the endpoint is unsafe. */
export function buildProvider(config: ResolvedProviderConfig): AIProvider {
  const { definition, baseUrl, model, apiKey } = config;

  if (definition.protocol === 'anthropic') {
    return new AnthropicAdapter({ apiKey: apiKey!, model });
  }

  return new OpenAICompatibleAdapter({
    providerId: definition.id,
    baseUrl,
    apiKey,
    model,
    allowLocalhost: definition.allowLocalhost ?? false,
    appUrl: env.APP_URL,
  });
}

export async function getAiProvider(userId: string): Promise<AIProvider | null> {
  if (!features.ai) return null;

  const config = await resolveConfig(userId);
  if (!config) return null;

  try {
    return buildProvider(config);
  } catch (error) {
    // An unsafe or malformed endpoint must not take the app down; it just
    // means no AI this run.
    console.error('[ai] could not build provider for user', userId, error);
    return null;
  }
}
