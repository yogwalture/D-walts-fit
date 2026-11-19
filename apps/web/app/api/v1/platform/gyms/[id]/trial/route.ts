import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extendTrial } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

/**
 * Another week to decide.
 *
 * Its own permission rather than the console's read key, because granting
 * somebody the overview is not granting them the discount cupboard. The
 * reason is written into that gym's own audit log, where they can see it.
 */
export const POST = route(
  {
    permission: 'platform.trial.extend',
    schema: z.object({
      days: z.coerce.number().int().min(1).max(60),
      reason: z.string().trim().min(4).max(500),
    }),
  },
  async ({ input, actor, params, ipAddress }) => {
    const result = await extendTrial({
      actorUserId: actor.userId,
      organizationId: params.id!,
      days: input.days,
      reason: input.reason,
      ipAddress,
    });
    return NextResponse.json({ data: result });
  },
);
