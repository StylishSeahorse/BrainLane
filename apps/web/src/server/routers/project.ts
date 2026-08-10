import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { protectedProcedure, router } from '../trpc';

export const projectRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const projects = await prisma.project.findMany({
      where: { userId: ctx.user.id, status: 'ACTIVE' },
      include: {
        tasks: {
          where: { status: { notIn: ['DONE', 'CANCELLED'] } },
          select: { id: true, estimateMinutes: true, actualMinutes: true },
        },
        milestones: { orderBy: { dueAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((project) => ({
      ...project,
      openTaskCount: project.tasks.length,
      remainingMinutes: project.tasks.reduce(
        (sum, task) => sum + Math.max(0, task.estimateMinutes - task.actualMinutes),
        0,
      ),
      /**
       * Days since anything in the project was touched. This is the
       * project-level half of avoidance detection: a whole project going quiet
       * is a different and slower signal than one task being pushed.
       */
      daysSinceTouched: Math.floor(
        (Date.now() - project.lastTouchedAt.getTime()) / 86_400_000,
      ),
    }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #c2410c')
          .optional(),
        deadline: z.coerce.date().optional().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return prisma.project.create({
        data: {
          userId: ctx.user.id,
          name: input.name,
          description: input.description ?? null,
          color: input.color ?? null,
          deadline: input.deadline ?? null,
        },
      });
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await prisma.project.updateMany({
        where: { id: input.id, userId: ctx.user.id },
        data: { status: 'ARCHIVED' },
      });
      if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND' });
    }),
});
