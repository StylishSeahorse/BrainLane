import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, rewrap, seal } from './envelope';

const KEK = randomBytes(32);
const CONTEXT = { userId: 'user-1', purpose: 'google-refresh-token' };

describe('envelope encryption', () => {
  it('round-trips a secret', () => {
    const secret = '1//0eXampleRefreshToken';
    expect(open(seal(secret, CONTEXT, KEK), CONTEXT, KEK)).toBe(secret);
  });

  it('produces different ciphertext each time (fresh DEK and IV)', () => {
    const a = seal('same', CONTEXT, KEK);
    const b = seal('same', CONTEXT, KEK);
    expect(a).not.toBe(b);
    expect(open(a, CONTEXT, KEK)).toBe(open(b, CONTEXT, KEK));
  });

  it('handles unicode and empty payloads', () => {
    for (const secret of ['', 'ünïcödé — ✅ 日本語']) {
      expect(open(seal(secret, CONTEXT, KEK), CONTEXT, KEK)).toBe(secret);
    }
  });

  // The property that makes this worth more than plain column encryption:
  // an attacker with database write access cannot move ciphertext between rows.
  it('refuses to decrypt under a different userId', () => {
    const sealed = seal('secret', CONTEXT, KEK);
    expect(() => open(sealed, { ...CONTEXT, userId: 'user-2' }, KEK)).toThrow(/unwrap/i);
  });

  it('refuses to decrypt under a different purpose', () => {
    const sealed = seal('secret', CONTEXT, KEK);
    expect(() => open(sealed, { ...CONTEXT, purpose: 'ai-api-key' }, KEK)).toThrow(/unwrap/i);
  });

  it('is not fooled by context fields that concatenate identically', () => {
    // Without length-prefixing, {userId:'ab', purpose:'c'} and
    // {userId:'a', purpose:'bc'} would share an AAD.
    const sealed = seal('secret', { userId: 'ab', purpose: 'c' }, KEK);
    expect(() => open(sealed, { userId: 'a', purpose: 'bc' }, KEK)).toThrow(/unwrap/i);
  });

  it('refuses to decrypt under the wrong KEK', () => {
    const sealed = seal('secret', CONTEXT, KEK);
    expect(() => open(sealed, CONTEXT, randomBytes(32))).toThrow(/unwrap/i);
  });

  it('detects tampering with the ciphertext', () => {
    const parts = seal('secret', CONTEXT, KEK).split('.');
    const flipped = Buffer.from(parts[6]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[6] = flipped.toString('base64url');
    expect(() => open(parts.join('.'), CONTEXT, KEK)).toThrow(/tampered/i);
  });

  it('detects tampering with the wrapped DEK', () => {
    const parts = seal('secret', CONTEXT, KEK).split('.');
    const flipped = Buffer.from(parts[1]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[1] = flipped.toString('base64url');
    expect(() => open(parts.join('.'), CONTEXT, KEK)).toThrow(/unwrap/i);
  });

  it('rejects malformed input rather than misreading it', () => {
    for (const bad of ['', 'nonsense', 'v2.a.b.c.d.e.f', 'v1.only.three.parts']) {
      expect(() => open(bad, CONTEXT, KEK)).toThrow(/malformed/i);
    }
  });

  it('rejects a KEK of the wrong size', () => {
    expect(() => seal('secret', CONTEXT, randomBytes(16))).toThrow(/32 bytes/);
  });

  it('requires both context fields', () => {
    expect(() => seal('secret', { userId: '', purpose: 'x' }, KEK)).toThrow(/userId and purpose/);
  });
});

describe('KEK rotation', () => {
  it('re-wraps under a new KEK without changing the payload', () => {
    const newKek = randomBytes(32);
    const sealed = seal('rotate-me', CONTEXT, KEK);
    const rotated = rewrap(sealed, CONTEXT, KEK, newKek);

    expect(open(rotated, CONTEXT, newKek)).toBe('rotate-me');
    // Payload ciphertext is untouched — only the small wrapped DEK changes.
    expect(rotated.split('.').slice(4)).toEqual(sealed.split('.').slice(4));
    // The old KEK no longer opens it.
    expect(() => open(rotated, CONTEXT, KEK)).toThrow(/unwrap/i);
  });

  it('still enforces context binding after rotation', () => {
    const newKek = randomBytes(32);
    const rotated = rewrap(seal('secret', CONTEXT, KEK), CONTEXT, KEK, newKek);
    expect(() => open(rotated, { ...CONTEXT, userId: 'other' }, newKek)).toThrow(/unwrap/i);
  });
});
