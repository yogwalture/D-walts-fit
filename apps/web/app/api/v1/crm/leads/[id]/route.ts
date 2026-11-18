import { NextResponse } from 'next/server';
import { updateLeadInput } from '@gym/contracts';
import { getLead, updateLead } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'crm.lead.read' }, async ({ actor, params }) =>
  getLead(tenantOf(actor), actor.permissions, params.id!),
);

export const PATCH = route(
  { permission: 'crm.lead.update', schema: updateLeadInput },
  async ({ input, actor, params, ipAddress }) => {
    await updateLead(
      tenantOf(actor),
      actor.permissions,
      params.id!,
      {
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        city: input.city,
        source: input.source,
        sourceDetail: input.sourceDetail,
        interestedPlanId: input.interestedPlanId,
        budgetNote: input.budgetNote,
        assignedToOrgUserId: input.assignedToOrgUserId,
        nextFollowUpAt: input.nextFollowUpAt,
        notes: input.notes,
        status: input.status,
        lostReason: input.lostReason,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: { updated: true } }, { status: 200 });
  },
);
