import { NextResponse } from 'next/server';
import { resolveSession, revokeSession } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { clearSessionCookie, readBearerToken, readSessionToken } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * Logout revokes the session row server-side, not just the cookie. A stolen
 * token is dead the moment the user signs out, which is the whole reason the
 * session lives in the database rather than in a self-contained JWT.
 */
export const POST = route({ public: true }, async ({ request }) => {
  const token = readBearerToken(request) ?? (await readSessionToken());

  if (token) {
    const db = basePrismaForAuth();
    await resolveSession(db, token)
      .then(({ actor }) => revokeSession(db, actor.sessionId))
      .catch(() => undefined); // already invalid: nothing left to revoke
  }

  await clearSessionCookie();
  return NextResponse.json({ data: { ok: true } }, { status: 200 });
});
