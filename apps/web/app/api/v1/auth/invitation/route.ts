import { NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptInvitationInput } from '@gym/contracts';
import { acceptInvitation, describeInvitation, resolveSession } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * What the acceptance screen shows before anyone types anything: which gym,
 * which role, and which address it was sent to. Returns null rather than an
 * error for a bad token, so the page can render a plain "this link has
 * expired" instead of a stack of error states.
 */
export const GET = route(
  {
    public: true,
    source: 'query',
    schema: z.object({ token: z.string().min(16) }),
  },
  async ({ input }) => {
    const invitation = await describeInvitation(input.token);
    return NextResponse.json({ data: invitation }, { status: 200 });
  },
);

export const POST = route(
  { public: true, schema: acceptInvitationInput },
  async ({ input, ipAddress, userAgent }) => {
    const result = await acceptInvitation({
      token: input.token,
      fullName: input.fullName,
      password: input.password,
      ipAddress,
      userAgent,
    });

    const { view } = await resolveSession(basePrismaForAuth(), result.session.token);
    await setSessionCookie(result.session.token, result.session.expiresAt);

    return NextResponse.json({ data: { session: view } }, { status: 201 });
  },
);
