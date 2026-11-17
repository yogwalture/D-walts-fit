import { NextResponse } from 'next/server';
import { resetPasswordInput } from '@gym/contracts';
import { resetPassword } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { clearSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

export const POST = route(
  { public: true, schema: resetPasswordInput },
  async ({ input }) => {
    const result = await resetPassword(basePrismaForAuth(), {
      token: input.token,
      password: input.password,
    });

    // Every session died, including this browser's. Clear the cookie so the
    // user is not left holding a token the server has already revoked.
    await clearSessionCookie();

    return NextResponse.json(
      {
        data: {
          message: 'Your password has been changed. Sign in with it now.',
          sessionsRevoked: result.sessionsRevoked,
        },
      },
      { status: 200 },
    );
  },
);
