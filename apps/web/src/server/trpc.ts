/**
 * tRPC setup.
 *
 * `protectedProcedure` is the only way to reach user data: it resolves the
 * session and narrows `ctx.user` to non-null, so a router that forgets an auth
 * check does not typecheck rather than leaking rows.
 */
import 'server-only';
import { initTRPC, TRPCError } from '@trpc/server';
import type { User } from '@fluid/db';
import { getCurrentUser } from './auth/session';

export interface Context {
  user: User | null;
}

export async function createContext(): Promise<Context> {
  return { user: await getCurrentUser() };
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Zod issues are safe to surface — they describe the caller's own
        // input. Everything else keeps tRPC's generic message.
        validation:
          error.cause instanceof Error && error.code === 'BAD_REQUEST'
            ? error.cause.message
            : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }
  // Narrowing user to non-null is what makes ownership checks in the routers
  // a type-level guarantee rather than a convention.
  return next({ ctx: { user: ctx.user } });
});
