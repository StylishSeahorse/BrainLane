import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { CalendarError } from '@fluid/calendar';
import { UnsafeEndpointError } from '@fluid/net';
import { protectedProcedure, router } from '../trpc';
import {
  connectCalDav,
  disconnectCalDav,
  setWriteTarget,
  syncAllConnections,
} from '../services/caldav';

/**
 * Turn a failure into something a person can act on.
 *
 * These three cases cover essentially every way connecting goes wrong, and each
 * has a different fix — wrong address, wrong password, unreachable server. A
 * single "connection failed" would leave someone guessing between them.
 */
function asUserFacingError(error: unknown): TRPCError {
  if (error instanceof UnsafeEndpointError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }

  if (error instanceof CalendarError) {
    return new TRPCError({
      code: error.retryable ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
      message: error.message,
    });
  }

  return new TRPCError({
    code: 'BAD_REQUEST',
    message:
      error instanceof Error
        ? `Could not reach that server: ${error.message}`
        : 'Could not reach that server.',
  });
}

export const calendarRouter = router({
  /** Connected accounts, their calendars, and recent sync history. */
  connections: protectedProcedure.query(async ({ ctx }) => {
    const connections = await prisma.calendarConnection.findMany({
      where: { userId: ctx.user.id },
      include: {
        calendars: { orderBy: { name: 'asc' } },
        syncLogs: { orderBy: { startedAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'asc' },
    });

    const stuck = await prisma.pendingRemoteOp.count({
      where: { connection: { userId: ctx.user.id }, status: 'DEAD_LETTER' },
    });

    return {
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        account: connection.accountIdentifier,
        status: connection.status,
        statusDetail: connection.statusDetail,
        lastSyncAt: connection.lastSyncAt,
        calendars: connection.calendars.map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          timeZone: calendar.timeZone,
          canWrite: calendar.canWrite,
          isSelected: calendar.isSelected,
          isWriteTarget: calendar.isWriteTarget,
        })),
        history: connection.syncLogs.map((log) => ({
          id: log.id,
          outcome: log.outcome,
          message: log.message,
          startedAt: log.startedAt,
        })),
      })),
      // Surfaced rather than buried: a write we could not deliver is something
      // the user should know about, not a silent divergence between what the
      // app shows and what their calendar holds.
      undeliveredWrites: stuck,
    };
  }),

  connect: protectedProcedure
    .input(
      z.object({
        serverUrl: z.string().trim().min(1).max(500),
        username: z.string().trim().min(1).max(200),
        password: z.string().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await connectCalDav(ctx.user.id, input);

        await prisma.auditLog.create({
          data: {
            userId: ctx.user.id,
            action: 'calendar.connected',
            // The address, never the password. An audit log is the last place
            // a credential should end up.
            metadata: { provider: 'CALDAV', host: new URL(input.serverUrl).host },
          },
        });

        return result;
      } catch (error) {
        throw asUserFacingError(error);
      }
    }),

  disconnect: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await disconnectCalDav(ctx.user.id, input.connectionId);
      await prisma.auditLog.create({
        data: { userId: ctx.user.id, action: 'calendar.disconnected', metadata: {} },
      });
    }),

  /** Whether a calendar's events count as busy time for the scheduler. */
  setSelected: protectedProcedure
    .input(z.object({ calendarId: z.string().min(1), isSelected: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.calendar.updateMany({
        where: { id: input.calendarId, userId: ctx.user.id },
        data: { isSelected: input.isSelected },
      });
    }),

  /** Which calendar receives scheduled blocks. Exactly one, per user. */
  setWriteTarget: protectedProcedure
    .input(z.object({ calendarId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await setWriteTarget(ctx.user.id, input.calendarId);
      } catch (error) {
        throw asUserFacingError(error);
      }
    }),

  sync: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await syncAllConnections(ctx.user.id);
    } catch (error) {
      throw asUserFacingError(error);
    }
  }),

  /** Clear a halted connection once the user has looked at what happened. */
  resume: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.calendarConnection.updateMany({
        where: { id: input.connectionId, userId: ctx.user.id, status: 'NEEDS_ATTENTION' },
        data: { status: 'ACTIVE', statusDetail: null },
      });
    }),
});
