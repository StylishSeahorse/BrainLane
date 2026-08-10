/**
 * Server-side tRPC caller.
 *
 * Server Components call the routers directly through this — same procedures,
 * same auth middleware, same validation as an HTTP request, minus the network
 * hop and the client-side data-fetching layer. One API surface, two transports.
 */
import 'server-only';
import { appRouter } from './routers/_app';
import { createContext } from './trpc';

export async function getCaller() {
  return appRouter.createCaller(await createContext());
}
