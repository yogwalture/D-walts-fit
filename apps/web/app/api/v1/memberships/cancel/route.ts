import { NextResponse } from 'next/server';
import { cancelInput } from '@gym/contracts';
import { cancelSubscription } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'memberships.subscription.cancel', schema: cancelInput },
  async ({ input, actor, ipAddress }) => {
    const result = await cancelSubscription(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
