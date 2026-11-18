import { NextResponse } from 'next/server';
import { planAssessmentQuery, planChangeInput } from '@gym/contracts';
import { assessPlanChange, changePlan, getTenantBilling } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'org.billing.read' }, async ({ actor }) => {
  const billing = await getTenantBilling(tenantOf(actor), actor.permissions);
  return NextResponse.json({ data: billing });
});

/** What a change would do, asked before it is made. */
export const PUT = route(
  { permission: 'org.billing.read', source: 'query', schema: planAssessmentQuery },
  async ({ input, actor }) => {
    const assessment = await assessPlanChange(tenantOf(actor), actor.permissions, {
      planKey: input.planKey,
    });
    return NextResponse.json({ data: assessment });
  },
);

/**
 * Moves the gym onto another plan.
 *
 * No money is taken here. What a gym owes for a mid-period change is
 * settled on their next invoice — a button labelled "change plan" must not
 * charge a card.
 */
export const POST = route(
  { permission: 'org.billing.update', schema: planChangeInput },
  async ({ input, actor, ipAddress }) => {
    const result = await changePlan(
      tenantOf(actor),
      actor.permissions,
      { planKey: input.planKey, reason: input.reason },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);
