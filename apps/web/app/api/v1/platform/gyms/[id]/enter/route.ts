import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enterTenantForSupport } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

/**
 * Entering a gym to help with something.
 *
 * Deliberately noisy: it writes a row the gym owner can see in their own
 * audit log. Support access that leaves no trace is indistinguishable from
 * a breach, so the reason is required and recorded before anything is read.
 */
export const POST = route(
  {
    permission: 'platform.impersonate.create',
    schema: z.object({ reason: z.string().trim().min(8).max(500) }),
  },
  async ({ input, actor, params, ipAddress }) => {
    await enterTenantForSupport({
      actorUserId: actor.userId,
      organizationId: params.id!,
      reason: input.reason,
      ipAddress,
    });
    return NextResponse.json({ data: { ok: true } });
  },
);
