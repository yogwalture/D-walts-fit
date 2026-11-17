import { z } from 'zod';
import { getActionLists } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

/**
 * The three lists a gym actually works from: expiring soon, money overdue,
 * and members who have gone quiet. A dashboard that only shows numbers tells
 * an owner how they did; these tell them who to ring.
 */
export const GET = route(
  { permission: 'analytics.dashboard.read', source: 'query', schema: query },
  async ({ input, actor }) => getActionLists(tenantOf(actor), actor.permissions, input),
);
