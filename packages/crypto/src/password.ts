/**
 * Password hashing.
 *
 * Argon2id is the current recommendation (OWASP): memory-hard, so GPU and ASIC
 * attacks gain far less than they do against PBKDF2 or bcrypt. We use
 * `@node-rs/argon2` rather than the `argon2` package because it ships prebuilt
 * binaries — no node-gyp, no C++ build chain, which matters on Windows.
 *
 * Parameters follow OWASP's Argon2id guidance (19 MiB, t=2, p=1). The cost is
 * deliberately felt on login; that is the entire point.
 */
import { hash, verify } from '@node-rs/argon2';

/**
 * `algorithm` is intentionally omitted: @node-rs/argon2 defaults to Argon2id,
 * which is what we want. Naming it explicitly would mean importing the
 * library's ambient `const enum`, which is not accessible under
 * `verbatimModuleSyntax` — and hardcoding its numeric value would be worse than
 * relying on a documented default.
 */
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Reject passwords that are trivially guessable before we spend CPU on them.
 * Length is the property that actually correlates with strength, so we require
 * length rather than imposing character-class rules (which push users toward
 * predictable substitutions and are no longer recommended).
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256; // Bound the work an attacker can force.

export function validatePasswordLength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = validatePasswordLength(password);
  if (problem) throw new Error(problem);
  // The salt is generated internally and embedded in the returned PHC string.
  return hash(password, OPTIONS);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  // Bound the work regardless of what was submitted.
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(digest, password);
  } catch {
    // A malformed stored digest must read as "wrong password", never as a crash
    // that distinguishes this account from any other.
    return false;
  }
}

/**
 * Burn roughly the same CPU as a real verification, for logins where no user
 * with that email exists. Without this, response timing tells an attacker which
 * addresses are registered.
 */
export async function fakeVerify(): Promise<false> {
  await hash('fluid-timing-equalizer-placeholder', OPTIONS);
  return false;
}
