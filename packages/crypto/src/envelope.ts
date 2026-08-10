/**
 * Envelope encryption for the secret vault: OAuth refresh tokens and
 * user-supplied AI API keys.
 *
 * Why envelope encryption rather than encrypting directly under one key:
 *
 *   - Each record gets its own data-encryption key (DEK), so a single
 *     compromised ciphertext never yields a key that opens other records.
 *   - Rotating the key-encryption key (KEK) only requires re-wrapping the small
 *     DEK of each row, not re-encrypting every payload.
 *   - Additional authenticated data binds each ciphertext to the user and
 *     purpose it was created for. An attacker with database write access cannot
 *     copy row A's Google refresh token onto row B and have it decrypt — the
 *     GCM tag check fails. This is the property that plain column encryption
 *     lacks, and it is the one that matters when the threat model includes
 *     "someone can write to the database".
 *
 * Serialized form (all fields base64url, which contains no '.' separator):
 *   v1.<wrappedDek>.<dekIv>.<dekTag>.<payloadIv>.<payloadTag>.<ciphertext>
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const VERSION = 'v1';

/**
 * Identifies what a ciphertext is for. Mixed into the GCM tag as additional
 * authenticated data, so a ciphertext only ever decrypts in the exact context
 * it was encrypted in.
 */
export interface SecretContext {
  /** Owner of the secret. */
  userId: string;
  /** What the secret is, e.g. `google-refresh-token`, `ai-api-key`. */
  purpose: string;
}

function canonicalAad(context: SecretContext): Buffer {
  if (!context.userId || !context.purpose) {
    throw new Error('SecretContext requires both userId and purpose');
  }
  // Length-prefixed so ({userId: 'a', purpose: 'bc'}) and ({userId: 'ab',
  // purpose: 'c'}) cannot produce the same AAD.
  return Buffer.from(
    `${VERSION}|${context.userId.length}:${context.userId}|${context.purpose.length}:${context.purpose}`,
    'utf8',
  );
}

function b64u(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * Decode a field of known length. IVs, GCM tags and the wrapped DEK all have
 * fixed sizes, so checking them here rejects malformed records before they
 * reach the cipher — and keeps the "malformed" and "tampered" errors distinct.
 */
function unb64uExact(value: string, bytes: number, field: string): Buffer {
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.length !== bytes) {
    throw new Error(`Malformed ciphertext: ${field} must be ${bytes} bytes, got ${buffer.length}`);
  }
  return buffer;
}

/**
 * Decode a variable-length field. Zero length is valid: an empty plaintext
 * encrypts to an empty ciphertext under GCM, where the tag does the
 * authenticating.
 */
function unb64u(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

const TAG_BYTES = 16;

/** Encrypt a secret. `kek` must be exactly 32 bytes. */
export function seal(plaintext: string, context: SecretContext, kek: Buffer): string {
  if (kek.length !== KEY_BYTES) {
    throw new Error(`KEK must be ${KEY_BYTES} bytes, received ${kek.length}`);
  }

  const aad = canonicalAad(context);

  // 1. Encrypt the payload under a fresh, single-use DEK.
  const dek = randomBytes(KEY_BYTES);
  const payloadIv = randomBytes(IV_BYTES);
  const payloadCipher = createCipheriv(ALGORITHM, dek, payloadIv);
  payloadCipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    payloadCipher.update(plaintext, 'utf8'),
    payloadCipher.final(),
  ]);
  const payloadTag = payloadCipher.getAuthTag();

  // 2. Wrap the DEK under the KEK, with the same AAD binding.
  const dekIv = randomBytes(IV_BYTES);
  const dekCipher = createCipheriv(ALGORITHM, kek, dekIv);
  dekCipher.setAAD(aad);
  const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
  const dekTag = dekCipher.getAuthTag();

  // 3. Clear the plaintext DEK from memory as soon as it is no longer needed.
  //    Not a guarantee under a GC that may have copied it, but it shortens the
  //    window in which a heap dump is useful.
  dek.fill(0);

  return [VERSION, wrappedDek, dekIv, dekTag, payloadIv, payloadTag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : b64u(part)))
    .join('.');
}

/**
 * Decrypt a secret. Throws if the ciphertext was tampered with, or if the
 * context does not match the one it was sealed under.
 */
export function open(serialized: string, context: SecretContext, kek: Buffer): string {
  if (kek.length !== KEY_BYTES) {
    throw new Error(`KEK must be ${KEY_BYTES} bytes, received ${kek.length}`);
  }

  const parts = serialized.split('.');
  if (parts.length !== 7 || parts[0] !== VERSION) {
    throw new Error('Malformed ciphertext: unexpected format or version');
  }

  const [, wrappedDekRaw, dekIvRaw, dekTagRaw, payloadIvRaw, payloadTagRaw, ciphertextRaw] =
    parts as [string, string, string, string, string, string, string];

  const aad = canonicalAad(context);

  // Decode fixed-size fields first. A length problem is a malformed record,
  // which is a different failure from a failed authentication tag.
  const wrappedDek = unb64uExact(wrappedDekRaw, KEY_BYTES, 'wrappedDek');
  const dekIv = unb64uExact(dekIvRaw, IV_BYTES, 'dekIv');
  const dekTag = unb64uExact(dekTagRaw, TAG_BYTES, 'dekTag');
  const payloadIv = unb64uExact(payloadIvRaw, IV_BYTES, 'payloadIv');
  const payloadTag = unb64uExact(payloadTagRaw, TAG_BYTES, 'payloadTag');

  // 1. Unwrap the DEK. A failure here means either a tampered record or the
  //    wrong KEK — do not distinguish the two in the error.
  let dek: Buffer;
  try {
    const dekDecipher = createDecipheriv(ALGORITHM, kek, dekIv);
    dekDecipher.setAAD(aad);
    dekDecipher.setAuthTag(dekTag);
    dek = Buffer.concat([dekDecipher.update(wrappedDek), dekDecipher.final()]);
  } catch {
    throw new Error('Failed to unwrap data key: wrong KEK, wrong context, or tampered record');
  }

  // 2. Decrypt the payload.
  try {
    const payloadDecipher = createDecipheriv(ALGORITHM, dek, payloadIv);
    payloadDecipher.setAAD(aad);
    payloadDecipher.setAuthTag(payloadTag);
    return Buffer.concat([
      payloadDecipher.update(unb64u(ciphertextRaw)),
      payloadDecipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt secret: tampered record');
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wrap a record's DEK under a new KEK without decrypting the payload.
 * This is what makes KEK rotation cheap — and it means a rotation never has
 * the plaintext secret in memory at all.
 */
export function rewrap(
  serialized: string,
  context: SecretContext,
  oldKek: Buffer,
  newKek: Buffer,
): string {
  const parts = serialized.split('.');
  if (parts.length !== 7 || parts[0] !== VERSION) {
    throw new Error('Malformed ciphertext: unexpected format or version');
  }
  const [, wrappedDekRaw, dekIvRaw, dekTagRaw] = parts as [string, string, string, string];
  const aad = canonicalAad(context);

  let dek: Buffer;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      oldKek,
      unb64uExact(dekIvRaw, IV_BYTES, 'dekIv'),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(unb64uExact(dekTagRaw, TAG_BYTES, 'dekTag'));
    dek = Buffer.concat([
      decipher.update(unb64uExact(wrappedDekRaw, KEY_BYTES, 'wrappedDek')),
      decipher.final(),
    ]);
  } catch {
    throw new Error('Failed to unwrap data key during rotation');
  }

  try {
    const newDekIv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, newKek, newDekIv);
    cipher.setAAD(aad);
    const newWrappedDek = Buffer.concat([cipher.update(dek), cipher.final()]);
    const newDekTag = cipher.getAuthTag();

    return [
      VERSION,
      b64u(newWrappedDek),
      b64u(newDekIv),
      b64u(newDekTag),
      parts[4],
      parts[5],
      parts[6],
    ].join('.');
  } finally {
    dek.fill(0);
  }
}

/** Length-safe constant-time comparison for opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing fixed-size digests keeps the comparison uniform.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
