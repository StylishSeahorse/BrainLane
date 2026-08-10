/**
 * HTTP transport for the same routers the server components call directly.
 *
 * Not used by the current UI — which talks to the routers in-process — but it
 * exists so a mobile client or a future client-side cache can reach the exact
 * same procedures, with the same auth middleware, rather than needing a second
 * API written alongside it.
 */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers/_app';
import { createContext } from '@/server/trpc';

function handler(request: Request) {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext,
  });
}

export { handler as GET, handler as POST };
