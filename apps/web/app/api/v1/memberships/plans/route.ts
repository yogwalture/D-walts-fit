import { NextResponse } from 'next/server';
import { createPlanInput } from '@gym/contracts';
import { createPlan, listPlans } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'memberships.plan.read' }, async ({ actor }) =>
  listPlans(tenantOf(actor), actor.permissions),
);

/**
 * Creates a plan.
 *
 * The fields are mapped one by one rather than spread. Every field here is
 * optional on the service's side, so a spread would let a renamed contract
 * field be silently dropped — the plan would save with the wrong session
 * count or visible when it should be hidden, and nothing would complain.
 * Written out, a rename is a type error.
 */
export const POST = route(
  { permission: 'memberships.plan.manage', schema: createPlanInput },
  async ({ input, actor, ipAddress }) => {
    const plan = await createPlan(
      tenantOf(actor),
      actor.permissions,
      {
        name: input.name,
        description: input.description,
        category: input.category,
        durationUnit: input.durationUnit,
        durationValue: input.durationValue,
        sessionCount: input.sessionCount,
        price: input.price,
        taxRateId: input.taxRateId,
        priceIncludesTax: input.priceIncludesTax,
        joiningFee: input.joiningFee,
        graceDays: input.graceDays,
        freezeAllowed: input.freezeAllowed,
        freezeMaxDays: input.freezeMaxDays,
        transferAllowed: input.transferAllowed,
        discountAllowed: input.discountAllowed,
        branchIds: input.branchIds,
        includedServices: input.includedServices,
        visibleToMembers: input.visibleToMembers,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: plan }, { status: 201 });
  },
);
