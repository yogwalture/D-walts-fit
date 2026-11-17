import { dashboardQuery } from '@gym/contracts';
import { getDashboardSummary } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'analytics.dashboard.read', source: 'query', schema: dashboardQuery },
  async ({ input, actor }) =>
    // Mapped field by field rather than spread: the service names these
    // `from` and `to`, and both are optional — so a spread would have
    // dropped a custom range silently and shown the default instead.
    getDashboardSummary(tenantOf(actor), actor.permissions, {
      range: input.range,
      from: input.fromDate,
      to: input.toDate,
      branchId: input.branchId,
    }),
);
