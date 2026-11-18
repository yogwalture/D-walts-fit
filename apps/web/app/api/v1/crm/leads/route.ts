import { NextResponse } from 'next/server';
import { createLeadInput, leadListQuery } from '@gym/contracts';
import { createLead, listLeads } from '@gym/core';
import { route, paged } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'crm.lead.read', source: 'query', schema: leadListQuery },
  async ({ input, actor }) => {
    const { rows, total } = await listLeads(tenantOf(actor), actor.permissions, {
      page: input.page,
      pageSize: input.pageSize,
      filter: input.filter,
      status: input.status,
      assignedToOrgUserId: input.assignedToOrgUserId,
      branchId: input.branchId,
      search: input.search,
    });
    return NextResponse.json(paged(rows, total, input.page, input.pageSize), { status: 200 });
  },
);

export const POST = route(
  { permission: 'crm.lead.create', schema: createLeadInput },
  async ({ input, actor, ipAddress }) => {
    const lead = await createLead(
      tenantOf(actor),
      actor.permissions,
      {
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        city: input.city,
        source: input.source,
        sourceDetail: input.sourceDetail,
        interestedPlanId: input.interestedPlanId,
        budgetNote: input.budgetNote,
        branchId: input.branchId,
        assignedToOrgUserId: input.assignedToOrgUserId,
        nextFollowUpAt: input.nextFollowUpAt,
        notes: input.notes,
        allowDuplicate: input.allowDuplicate,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: lead }, { status: 201 });
  },
);
