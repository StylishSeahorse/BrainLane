/**
 * Resolves which AI provider (if any) to use for a given user.
 *
 * The key precedence is deliberate: a user's own key wins over the server's, so
 * "bring your own key" means their traffic and their bill, not ours. Returning
 * `null` is a first-class outcome — every caller must already handle the
 * deterministic path, so "no AI configured" needs no special case.
 */
import 'server-only';
import { env, features } from '@fluid/env';
import { prisma } from '@fluid/db';
import { openSecret } from '@fluid/crypto';
import type { AIProvider } from '@fluid/ai';
import { AnthropicAdapter } from '@fluid/ai/adapters/anthropic';

export async function getAiProvider(userId: string): Promise<AIProvider | null> {
  if (!features.ai) return null;

  const setting = await prisma.aiSetting.findUnique({ where: { userId } });

  let apiKey: string | undefined;

  if (setting?.encryptedApiKey) {
    try {
      apiKey = openSecret(setting.encryptedApiKey, { userId, purpose: 'ai-api-key' });
    } catch (error) {
      // A key that will not decrypt is a real problem, but not one worth
      // failing the user's whole schedule over — fall through to the server
      // key, and ultimately to the deterministic scheduler.
      console.error('[ai] could not decrypt stored API key for user', userId, error);
    }
  }

  apiKey ??= env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  switch (setting?.provider ?? 'ANTHROPIC') {
    case 'ANTHROPIC':
      return new AnthropicAdapter({
        apiKey,
        ...(setting?.model ? { model: setting.model } : {}),
      });
    default:
      // OpenAI, Gemini and local adapters are later steps. The interface is
      // final, so adding one is a new case here and nothing else.
      return null;
  }
}
