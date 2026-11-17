import { NextResponse } from 'next/server';
import { unfreezeInput } from '@gym/contracts';
import { unfreezeSubscription } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'memberships.subscription.freeze', schema: unfreezeInput },
  async ({ input, actor, ipAddress }) => {
    const result = await unfreezeSubscription(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
