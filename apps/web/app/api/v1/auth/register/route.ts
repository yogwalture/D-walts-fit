import { NextResponse } from 'next/server';
import { registerGymInput } from '@gym/contracts';
import { registerGym, resolveSession } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * Self-serve gym registration. Creates the tenant and signs the owner in,
 * so there is no dead end between "register" and "use the product".
 */
export const POST = route(
  { public: true, schema: registerGymInput },
  async ({ input, ipAddress, userAgent }) => {
    const result = await registerGym({ ...input, ipAddress, userAgent });

    const { view } = await resolveSession(basePrismaForAuth(), result.session.token);
    await setSessionCookie(result.session.token, result.session.expiresAt);

    return NextResponse.json(
      {
        data: {
          session: view,
          organizationSlug: result.organizationSlug,
        },
      },
      { status: 201 },
    );
  },
);
