/**
 * Session management.
 *
 * Opaque, database-backed sessions rather than JWTs. The token exists in the
 * user's cookie; what we store is a SHA-256 digest, so a database dump cannot
 * be replayed as live logins. Revocation is a DELETE — with a stateless JWT it
 * is a wish.
 *
 * The cookie is `httpOnly` + `SameSite=Strict`, so JavaScript can never read it
 * and it is not sent on cross-site requests. That combination is why an XSS bug
 * here does not become account takeover, and why there is no CSRF token to get
 * wrong.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from '@fluid/env';
import { prisma, type User } from '@fluid/db';
import { generateToken, hashToken } from '@fluid/crypto';

const COOKIE_NAME = 'fluid_session';
const SESSION_DAYS = 30;
/** Refresh the cookie only once a day, to avoid a write on every request. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

/** Issue a new session and set the cookie. Returns the raw token (once). */
export async function createSession(userId: string): Promise<void> {
  const token = generateToken();
  const now = new Date();

  const headerList = await headers();

  await prisma.session.create({
    data: {
      userId,
      tokenDigest: hashToken(token),
      expiresAt: expiryFrom(now),
      // Coarse, for the "your active sessions" screen. Nothing more.
      userAgent: headerList.get('user-agent')?.slice(0, 256) ?? null,
      ipAddress:
        headerList.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 64) ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    // Secure in production only — localhost is http, and a Secure cookie
    // would silently never be sent in development.
    secure: env.NODE_ENV === 'production',
    path: '/',
    expires: expiryFrom(now),
  });
}

/**
 * Resolve the current user, or null.
 *
 * Expired sessions are deleted on sight rather than merely rejected, so the
 * table does not accumulate dead rows waiting on a cleanup job.
 */
export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenDigest: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;

  if (session.expiresAt <= new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  const now = new Date();
  if (now.getTime() - session.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    await prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt: expiryFrom(now) },
      })
      .catch(() => {});
  }

  return session.user;
}

/**
 * Resolve the current user, or redirect to the login page.
 *
 * Every protected page calls this rather than relying on the layout's guard.
 * Next renders layouts and pages concurrently, so a page that assumes the
 * layout has already redirected will still execute its own body against a null
 * user — which shows up as a `Cannot read properties of null` before the
 * redirect lands. Checking per page makes the guard deterministic.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/** Destroy the current session, both server-side and in the browser. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (token) {
    await prisma.session.deleteMany({ where: { tokenDigest: hashToken(token) } });
  }
  cookieStore.delete(COOKIE_NAME);
}

/** Invalidate every session for a user — used on password change. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
