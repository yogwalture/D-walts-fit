import { z } from 'zod';
import { isoDate } from '@gym/contracts';
import { dailyCollection } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const query = z.object({
  date: isoDate.optional(),
  branchId: z.string().uuid().optional(),
});

/** What is in the till today, split by method — the end-of-shift number. */
export const GET = route(
  { permission: 'finance.payment.read', source: 'query', schema: query },
  async ({ input, actor }) => dailyCollection(tenantOf(actor), actor.permissions, input),
);
