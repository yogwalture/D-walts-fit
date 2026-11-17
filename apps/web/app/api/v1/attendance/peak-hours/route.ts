import { peakHoursQuery } from '@gym/contracts';
import { peakHours } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'attendance.report.read', source: 'query', schema: peakHoursQuery },
  async ({ input, actor }) => peakHours(tenantOf(actor), actor.permissions, input),
);
