import { chartsQuery } from '@gym/contracts';
import { getCharts } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'analytics.dashboard.read', source: 'query', schema: chartsQuery },
  async ({ input, actor }) => getCharts(tenantOf(actor), actor.permissions, input),
);
