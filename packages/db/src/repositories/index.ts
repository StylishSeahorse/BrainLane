/**
 * Repositories — the write paths that carry a rule with them.
 *
 * Exported from a subpath rather than the package root so a call site has to
 * say which vocabulary it is reaching for. `@fluid/db` gives you Prisma;
 * `@fluid/db/repositories` gives you the guarded operations, and the ownership
 * rule that comes with them.
 */
export {
  appBlockUid,
  createAppBlock,
  updateAppBlock,
  softDeleteAppBlock,
  restoreAppBlock,
  upsertFromRemote,
  tombstoneFromRemote,
  findBusyInRange,
  findByUid,
  findByExternalId,
  EventOwnershipError,
  type AppBlockDraft,
  type AppBlockPatch,
} from './events';
