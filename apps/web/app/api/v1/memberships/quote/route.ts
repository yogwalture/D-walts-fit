import { planQuoteQuery } from '@gym/contracts';
import { quotePlan } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * What the member will be charged, calculated by the same function the sale
 * uses. The counter never computes a total in the browser, so the figure on
 * screen and the figure on the invoice cannot disagree.
 */
export const GET = route(
  { permission: 'memberships.plan.read', source: 'query', schema: planQuoteQuery },
  async ({ input, actor }) =>
    quotePlan(tenantOf(actor), {
      planId: input.planId,
      startDate: input.startDate,
      discountCode: input.discountCode,
      overridePrice: input.overridePrice,
    }),
);
