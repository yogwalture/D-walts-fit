import { NextResponse } from 'next/server';
import { loginInput } from '@gym/contracts';
import { login, resolveSession } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

export const POST = route(
  { public: true, schema: loginInput },
  async ({ input, ipAddress, userAgent, request }) => {
    const db = basePrismaForAuth();
    const wantsBearer = request.headers.get('x-client') === 'mobile';

    const result = await login(db, {
      email: input.email,
      password: input.password,
      totp: input.totp,
      ipAddress,
      userAgent,
      type: wantsBearer ? 'MOBILE' : 'WEB',
    });

    const { view } = await resolveSession(db, result.session.token);

    // Mobile gets the token in the body; the browser gets an HTTP-only
    // cookie it cannot read. Both point at the same session row.
    if (wantsBearer) {
      return NextResponse.json(
        {
          data: {
            session: view,
            accessToken: result.session.token,
            refreshToken: result.session.refreshToken,
            expiresAt: result.session.expiresAt.toISOString(),
          },
        },
        { status: 200 },
      );
    }

    await setSessionCookie(result.session.token, result.session.expiresAt);
    return NextResponse.json({ data: { session: view } }, { status: 200 });
  },
);
