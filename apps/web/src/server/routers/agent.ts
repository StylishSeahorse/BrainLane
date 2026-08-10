import 'server-only';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { protectedProcedure, router } from '../trpc';
import { confirmAiAction, reflow, rejectAiAction, revertAiAction } from '../services/calendar-agent';

export const agentRouter = router({
  /** Let the AI rearrange the calendar, within the user's autonomy setting. */
  reflow: protectedProcedure
    .input(
      z
        .object({
          trigger: z
            .enum(['manual', 'task_skipped', 'task_overran', 'new_urgent_task'])
            .default('manual'),
        })
        .default({ trigger: 'manual' }),
    )
    .mutation(async ({ ctx, input }) => reflow(ctx.user.id, input.trigger)),

  /** The audit trail: everything done, proposed, or refused. */
  activity: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 }))
    .query(async ({ ctx, input }) => {
      return prisma.aiAction.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
    }),

  revert: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => revertAiAction(ctx.user.id, input.id)),

  confirm: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => confirmAiAction(ctx.user.id, input.id)),

  reject: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => rejectAiAction(ctx.user.id, input.id)),

  /** Read and change how much freedom the AI has. */
  autonomy: protectedProcedure.query(async ({ ctx }) => {
    const preferences = await prisma.userPreferences.findUnique({
      where: { userId: ctx.user.id },
    });
    return {
      level: preferences?.aiAutonomy ?? 'AUTO_WITH_UNDO',
      scope: preferences?.aiActionScope ?? 'TODAY',
      undoWindowSeconds: preferences?.undoWindowSeconds ?? 30,
    };
  }),

  setAutonomy: protectedProcedure
    .input(
      z.object({
        level: z.enum(['FULL_AUTO', 'AUTO_WITH_UNDO', 'PROPOSE_THEN_CONFIRM']),
        scope: z.enum(['TODAY', 'THIS_WEEK']),
        undoWindowSeconds: z.number().int().min(5).max(300),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.userPreferences.upsert({
        where: { userId: ctx.user.id },
        create: {
          userId: ctx.user.id,
          aiAutonomy: input.level,
          aiActionScope: input.scope,
          undoWindowSeconds: input.undoWindowSeconds,
        },
        update: {
          aiAutonomy: input.level,
          aiActionScope: input.scope,
          undoWindowSeconds: input.undoWindowSeconds,
        },
      });

      // Changing how much authority software has over your calendar is a
      // security-relevant event, so it goes in the audit log too.
      await prisma.auditLog.create({
        data: {
          userId: ctx.user.id,
          action: 'ai.autonomy.changed',
          metadata: { level: input.level, scope: input.scope },
        },
      });
    }),
});
