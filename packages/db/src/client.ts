/**
 * Prisma client singleton.
 *
 * Next.js dev mode reloads modules on every edit; without caching the instance
 * on `globalThis`, each reload opens a fresh connection pool until Postgres
 * refuses new connections.
 */
import { env } from '@fluid/env';
import { PrismaClient } from '../generated/client/index.js';

const globalForPrisma = globalThis as unknown as { fluidPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.fluidPrisma ??
  new PrismaClient({
    // Queries are noisy; warnings and errors are the ones worth seeing.
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.fluidPrisma = prisma;
}

export type { PrismaClient };
export type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
