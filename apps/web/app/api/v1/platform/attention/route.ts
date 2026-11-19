import { NextResponse } from 'next/server';
import { z } from 'zod';
import { gymsNeedingAttention } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

/**
 * The gyms somebody should ring today, most recoverable first.
 *
 * A count on a dashboard cannot be phoned, so this carries the name and the
 * number with each one.
 */
export const GET = route(
  {
    permission: 'platform.gym.read',
    source: 'query',
    schema: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  },
  async ({ input, actor }) => {
    const rows = await gymsNeedingAttention(actor.userId, { limit: input.limit });
    return NextResponse.json({ data: rows });
  },
);
