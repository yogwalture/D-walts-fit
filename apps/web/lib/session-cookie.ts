import { cookies } from 'next/headers';

/**
 * The session cookie.
 *
 * HTTP-only so JavaScript cannot read it, Secure in production so it never
 * travels in clear, SameSite=Lax so a cross-site form post cannot carry it —
 * which, with the origin check in the handler wrapper, is the CSRF defence.
 *
 * The value is an opaque random token. It carries no claims: everything about
 * the session, including which gym the user is acting in, is read from the
 * database row it points at. That is what makes the tenant unforgeable.
 */

export const SESSION_COOKIE = '__Host-gym_session';

const isProduction = process.env.NODE_ENV === 'production';

/** __Host- requires Secure and no Domain, which dev over plain HTTP cannot meet. */
export const cookieName = isProduction ? SESSION_COOKIE : 'gym_session';

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set({
    name: cookieName,
    value: token,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set({
    name: cookieName,
    value: '',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(cookieName)?.value ?? null;
}

/** Mobile clients send a bearer token instead; both resolve to one session row. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}
