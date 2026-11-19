import { NextResponse } from 'next/server';
import { z } from 'zod';
import { boolish, pageQuery, setGymStatusInput } from '@gym/contracts';
import { getPlatformStats, listGyms, setGymStatus } from '@gym/core';
import { route, paged } from '@/lib/handler';

export const dynamic = 'force-dynamic';

export const GET = route(
  {
    permission: 'platform.gym.read',
    source: 'query',
    schema: pageQuery.extend({
      status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']).optional(),
      withStats: boolish.default(false),
    }),
  },
  async ({ input, actor }) => {
    const [{ rows, total }, stats] = await Promise.all([
      listGyms(actor.userId, {
        page: input.page,
        pageSize: input.pageSize,
        search: input.search,
        status: input.status,
      }),
      input.withStats ? getPlatformStats(actor.userId) : Promise.resolve(null),
    ]);

    const body = paged(rows, total, input.page, input.pageSize);
    return NextResponse.json(stats ? { ...body, stats } : body, { status: 200 });
  },
);

/**
 * Suspending a gym closes access. It deletes nothing: the data stays and the
 * owner can still export it, which is both the decent thing and the legally
 * safe one.
 */
export const POST = route(
  { permission: 'platform.gym.suspend', schema: setGymStatusInput },
  async ({ input, actor, ipAddress }) => {
    await setGymStatus({
      actorUserId: actor.userId,
      organizationId: input.organizationId,
      status: input.status,
      reason: input.reason,
      ipAddress,
    });
    return NextResponse.json({ data: { ok: true, status: input.status } }, { status: 200 });
  },
);
