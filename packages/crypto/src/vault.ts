/**
 * Environment-bound wrapper over the envelope primitives.
 *
 * `envelope.ts` stays pure and takes the KEK as an argument so it is testable
 * without any environment at all. This module is the only place that binds it
 * to the configured key — and the only part of the crypto package that is
 * server-only.
 */
import { env } from '@fluid/env';
import { open, rewrap, seal, type SecretContext } from './envelope';

let cachedKek: Buffer | null = null;

function kek(): Buffer {
  // @fluid/env has already validated this is exactly 32 bytes at startup.
  cachedKek ??= Buffer.from(env.ENCRYPTION_KEK, 'base64');
  return cachedKek;
}

/** Encrypt a secret for storage. */
export function sealSecret(plaintext: string, context: SecretContext): string {
  return seal(plaintext, context, kek());
}

/** Decrypt a stored secret. Throws on tampering or context mismatch. */
export function openSecret(serialized: string, context: SecretContext): string {
  return open(serialized, context, kek());
}

/** Re-wrap a stored secret under a new KEK, without exposing the plaintext. */
export function rewrapSecret(
  serialized: string,
  context: SecretContext,
  newKekBase64: string,
): string {
  const newKek = Buffer.from(newKekBase64, 'base64');
  if (newKek.length !== 32) {
    throw new Error('New KEK must be 32 bytes, base64-encoded');
  }
  return rewrap(serialized, context, kek(), newKek);
}

export type { SecretContext };
