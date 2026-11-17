import { NextResponse } from 'next/server';
import { memberOtpRequestInput, memberOtpVerifyInput } from '@gym/contracts';
import { requestMemberOtp, resolveSession, verifyMemberOtp } from '@gym/core';
import { getEmailProvider, memberOtpEmail } from '@gym/integrations';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { setSessionCookie } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * Member login, step one: send a code.
 *
 * Answers identically for an unknown member, an unknown gym and a real one.
 * The member app's login screen must not double as a way of checking whether
 * a phone number is registered at a particular gym.
 */
export const POST = route(
  { public: true, schema: memberOtpRequestInput },
  async ({ input, ipAddress }) => {
    const result = await requestMemberOtp({
      identifier: input.identifier,
      organizationSlug: input.organizationSlug,
      ipAddress,
    });

    if (result.code && result.channel === 'email' && result.destination) {
      await getEmailProvider().send(
        memberOtpEmail({
          to: result.destination,
          memberName: result.memberName ?? 'there',
          code: result.code,
          gymName: input.organizationSlug,
        }),
      );
    }
    // WhatsApp delivery lands in Phase 4; until then the code goes to the
    // server log via the console email provider rather than nowhere.

    return NextResponse.json(
      { data: { message: 'If that account exists, a code is on its way.' } },
      { status: 200 },
    );
  },
);

/** Member login, step two: verify the code and open a session. */
export const PUT = route(
  { public: true, schema: memberOtpVerifyInput },
  async ({ input, ipAddress, userAgent }) => {
    const result = await verifyMemberOtp({
      identifier: input.identifier,
      organizationSlug: input.organizationSlug,
      code: input.code,
      ipAddress,
      userAgent,
    });

    const { view } = await resolveSession(basePrismaForAuth(), result.session.token);
    await setSessionCookie(result.session.token, result.session.expiresAt);

    return NextResponse.json({ data: { session: view } }, { status: 200 });
  },
);
