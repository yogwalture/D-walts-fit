import { z } from 'zod';
import { todaysAttendance } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const query = z.object({ branchId: z.string().uuid().optional() });

export const GET = route(
  { permission: 'attendance.record.read', source: 'query', schema: query },
  async ({ input, actor }) => todaysAttendance(tenantOf(actor), actor.permissions, input),
);
