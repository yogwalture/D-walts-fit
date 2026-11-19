import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setLimitOverrides } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

/**
 * A limit agreed with one gym.
 *
 * An empty object puts them back on their plan. `null` for a limit means
 * unlimited, which is deliberately different from leaving it out — one is a
 * decision, the other is silence.
 */
export const POST = route(
  {
    permission: 'platform.limit.override',
    schema: z.object({
      overrides: z.record(
        z.enum(['maxMembers', 'maxBranches', 'maxStaff']),
        z.coerce.number().int().min(0).nullable(),
      ),
      reason: z.string().trim().min(4).max(500),
    }),
  },
  async ({ input, actor, params, ipAddress }) => {
    await setLimitOverrides({
      actorUserId: actor.userId,
      organizationId: params.id!,
      overrides: input.overrides as Record<string, number | null>,
      reason: input.reason,
      ipAddress,
    });
    return NextResponse.json({ data: { ok: true } });
  },
);
