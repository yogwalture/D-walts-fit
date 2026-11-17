import { NextResponse } from 'next/server';
import { freezeInput } from '@gym/contracts';
import { freezeSubscription } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'memberships.subscription.freeze', schema: freezeInput },
  async ({ input, actor, ipAddress }) => {
    const result = await freezeSubscription(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
