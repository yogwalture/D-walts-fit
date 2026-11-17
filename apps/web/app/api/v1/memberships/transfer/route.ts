import { NextResponse } from 'next/server';
import { transferInput } from '@gym/contracts';
import { transferSubscription } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'memberships.subscription.transfer', schema: transferInput },
  async ({ input, actor, ipAddress }) => {
    const result = await transferSubscription(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
