import { NextResponse } from 'next/server';
import { disableMfaInput, enableMfaInput } from '@gym/contracts';
import { beginMfaSetup, confirmMfaSetup, disableMfa } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Two-factor authentication, enrolled in two steps.
 *
 * POST generates a secret and returns it with a QR URI. Nothing is switched
 * on yet. PUT verifies a code from that secret and only then enables it —
 * otherwise a mistyped setup locks someone out of their own gym.
 */
export const POST = route({}, async ({ actor }) => {
  const setup = await beginMfaSetup(basePrismaForAuth(), {
    userId: actor.userId,
    issuer: process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud',
  });
  return NextResponse.json({ data: setup }, { status: 200 });
});

export const PUT = route({ schema: enableMfaInput }, async ({ input, actor }) => {
  const { recoveryCodes } = await confirmMfaSetup(basePrismaForAuth(), {
    userId: actor.userId,
    totp: input.totp,
  });

  return NextResponse.json(
    {
      data: {
        enabled: true,
        recoveryCodes,
        notice:
          'Save these codes somewhere safe. Each works once, and they cannot be shown again.',
      },
    },
    { status: 200 },
  );
});

/** Turning it off needs the password, not just a session on a borrowed laptop. */
export const DELETE = route({ schema: disableMfaInput }, async ({ input, actor }) => {
  await disableMfa(basePrismaForAuth(), {
    userId: actor.userId,
    password: input.password,
  });
  return NextResponse.json({ data: { enabled: false } }, { status: 200 });
});
