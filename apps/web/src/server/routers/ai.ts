import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import {
  assertSafeEndpoint,
  getProvider,
  isKnownProvider,
  PROVIDERS,
  UnsafeEndpointError,
} from '@fluid/ai';
import { OpenAICompatibleAdapter } from '@fluid/ai/adapters/openai-compatible';
import { protectedProcedure, router } from '../trpc';
import { buildProvider, encryptApiKey, resolveConfig } from '../services/ai-provider';
import { checkReadiness } from '../services/ai-diagnostics';

export const aiRouter = router({
  /** The catalog, plus the user's current selection. */
  settings: protectedProcedure.query(async ({ ctx }) => {
    const setting = await prisma.aiSetting.findUnique({ where: { userId: ctx.user.id } });
    const definition = getProvider(setting?.providerId);

    return {
      providers: PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        blurb: provider.blurb,
        requiresKey: provider.requiresKey,
        editableBaseUrl: provider.editableBaseUrl ?? false,
        supportsModelListing: provider.supportsModelListing ?? false,
        defaultModel: provider.defaultModel ?? '',
        baseUrl: provider.baseUrl,
        keyUrl: provider.keyUrl ?? null,
        isCli: provider.protocol === 'cli',
        unverified: provider.unverified ?? false,
        signIn: provider.signIn ?? null,
        cliModelOptions: provider.cliModelOptions ?? null,
      })),
      current: {
        providerId: definition.id,
        model: setting?.model ?? '',
        baseUrl: setting?.baseUrl ?? '',
        // Never the key itself — only whether one is stored. The plaintext is
        // write-only by design; there is no read path back to the browser.
        hasKey: Boolean(setting?.encryptedApiKey),
        allowScheduling: setting?.allowScheduling ?? true,
        allowTaskBreakdown: setting?.allowTaskBreakdown ?? true,
        allowAvoidanceCheck: setting?.allowAvoidanceCheck ?? false,
        allowChat: setting?.allowChat ?? false,
        shareTaskText: setting?.shareTaskText ?? false,
      },
    };
  }),

  save: protectedProcedure
    .input(
      z.object({
        providerId: z.string().refine(isKnownProvider, 'Unknown provider.'),
        model: z.string().trim().max(200).optional(),
        baseUrl: z.string().trim().max(500).optional(),
        /** Empty string leaves the stored key untouched. */
        apiKey: z.string().trim().max(500).optional(),
        clearKey: z.boolean().default(false),
        allowScheduling: z.boolean(),
        allowTaskBreakdown: z.boolean(),
        allowAvoidanceCheck: z.boolean(),
        allowChat: z.boolean(),
        shareTaskText: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const definition = getProvider(input.providerId);

      // Validate a user-supplied endpoint before it is ever stored, so an
      // unsafe URL is rejected at the form rather than at request time.
      //
      // Re-thrown as BAD_REQUEST: a refused endpoint is invalid input, not a
      // server fault, and letting the raw error escape would return a stack
      // trace to the caller.
      let baseUrl: string | null = null;
      if (definition.editableBaseUrl && input.baseUrl) {
        try {
          assertSafeEndpoint(input.baseUrl, {
            allowLocalhost: definition.allowLocalhost ?? false,
          });
        } catch (error) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              error instanceof UnsafeEndpointError
                ? error.message
                : 'That endpoint URL cannot be used.',
          });
        }
        baseUrl = input.baseUrl;
      }

      const encryptedApiKey = input.clearKey
        ? null
        : input.apiKey
          ? encryptApiKey(ctx.user.id, input.apiKey)
          : undefined;

      const data = {
        providerId: input.providerId,
        model: input.model || null,
        baseUrl,
        allowScheduling: input.allowScheduling,
        allowTaskBreakdown: input.allowTaskBreakdown,
        allowAvoidanceCheck: input.allowAvoidanceCheck,
        allowChat: input.allowChat,
        shareTaskText: input.shareTaskText,
        ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
      };

      await prisma.aiSetting.upsert({
        where: { userId: ctx.user.id },
        create: { userId: ctx.user.id, ...data },
        update: data,
      });

      // Changing which third party receives your calendar metadata is
      // security-relevant, so it goes in the audit log.
      await prisma.auditLog.create({
        data: {
          userId: ctx.user.id,
          action: 'ai.provider.changed',
          metadata: { providerId: input.providerId, model: input.model ?? null },
        },
      });
    }),

  /**
   * Ask the provider what it actually serves.
   *
   * Model IDs are never hardcoded: vendors add and retire them constantly, and
   * a stale baked-in list sends people to a model that 404s.
   */
  models: protectedProcedure.query(async ({ ctx }) => {
    const config = await resolveConfig(ctx.user.id);
    if (!config || !config.definition.supportsModelListing) return { models: [] as string[] };

    try {
      const adapter = buildProvider(config);
      if (adapter instanceof OpenAICompatibleAdapter) {
        return { models: await adapter.listModels() };
      }
    } catch {
      // Listing is a convenience. If it fails the field still accepts any
      // model string typed by hand.
    }
    return { models: [] as string[] };
  }),

  /** Cheap pre-flight: is this provider set up, and if not, what fixes it? */
  readiness: protectedProcedure.query(async ({ ctx }) => checkReadiness(ctx.user.id)),

  /** Exercise the exact configuration the scheduler would use. */
  test: protectedProcedure.mutation(async ({ ctx }) => {
    const config = await resolveConfig(ctx.user.id);

    if (!config) {
      return {
        ok: false as const,
        message: 'Not configured yet — choose a provider and add a key.',
      };
    }

    try {
      const adapter = buildProvider(config);
      const ok = await adapter.healthCheck();

      return ok
        ? {
            ok: true as const,
            message: `Reached ${config.definition.label} using ${config.model}.`,
          }
        : {
            ok: false as const,
            message: `${config.definition.label} did not accept that request. Check the key and model name.`,
          };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Could not reach the provider.',
      };
    }
  }),
});
