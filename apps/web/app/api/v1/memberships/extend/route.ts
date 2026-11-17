import { NextResponse } from 'next/server';
import { extendInput } from '@gym/contracts';
import { extendSubscription } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'memberships.subscription.extend', schema: extendInput },
  async ({ input, actor, ipAddress }) => {
    const result = await extendSubscription(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
