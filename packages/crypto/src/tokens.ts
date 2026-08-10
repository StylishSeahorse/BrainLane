/**
 * Opaque token generation and storage-side hashing.
 *
 * Session tokens, calendar webhook channel tokens, and OAuth `state` values all
 * follow one rule: the raw token exists only in the client's cookie or the
 * provider's request. What we persist is a SHA-256 digest of it.
 *
 * SHA-256 is correct here — unlike a password, a 256-bit random token has no
 * guessable structure, so there is nothing for a slow KDF to protect against.
 * The digest exists so a leaked database dump cannot be replayed as live
 * sessions.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32; // 256 bits

/** Generate a new opaque token. Return this to the client exactly once. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Digest a token for storage or lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * Compare a presented token against a stored digest in constant time.
 * Both sides are fixed-length digests, so the comparison leaks nothing.
 */
export function verifyToken(presented: string, storedDigest: string): boolean {
  const a = Buffer.from(hashToken(presented), 'utf8');
  const b = Buffer.from(storedDigest, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
