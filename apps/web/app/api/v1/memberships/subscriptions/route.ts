import { NextResponse } from 'next/server';
import { subscriptionListQuery } from '@gym/contracts';
import { listSubscriptions } from '@gym/core';
import { route, paged } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'memberships.subscription.read', source: 'query', schema: subscriptionListQuery },
  async ({ input, actor }) => {
    const { rows, total } = await listSubscriptions(tenantOf(actor), actor.permissions, {
      page: input.page,
      pageSize: input.pageSize,
      status: input.status,
      planId: input.planId,
      branchId: input.branchId,
      memberId: input.memberId,
      expiringWithinDays: input.expiringWithinDays,
      search: input.search,
    });
    return NextResponse.json(paged(rows, total, input.page, input.pageSize), { status: 200 });
  },
);
