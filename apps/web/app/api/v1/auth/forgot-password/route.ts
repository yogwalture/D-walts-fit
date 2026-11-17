import { NextResponse } from 'next/server';
import { forgotPasswordInput } from '@gym/contracts';
import { requestPasswordReset } from '@gym/core';
import { getEmailProvider, passwordResetEmail } from '@gym/integrations';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Always answers the same way, whether or not the address has an account.
 * Anything else turns this form into a way of asking the system who its
 * users are.
 */
export const POST = route(
  { public: true, schema: forgotPasswordInput },
  async ({ input, ipAddress }) => {
    const result = await requestPasswordReset(basePrismaForAuth(), {
      email: input.email,
      ipAddress,
    });

    if (result.token) {
      await getEmailProvider().send(
        passwordResetEmail({
          to: input.email,
          fullName: result.fullName ?? 'there',
          token: result.token,
        }),
      );
    }

    return NextResponse.json(
      {
        data: {
          message:
            'If that address has an account, a reset link is on its way. It expires in 30 minutes.',
        },
      },
      { status: 200 },
    );
  },
);
