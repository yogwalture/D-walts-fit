import { NextResponse } from 'next/server';
import { convertLeadInput } from '@gym/contracts';
import { convertLead } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** One transaction: a half-converted enquiry is the worst outcome. */
export const POST = route(
  { permission: 'crm.lead.update', schema: convertLeadInput },
  async ({ input, actor, ipAddress }) => {
    const member = await convertLead(
      tenantOf(actor),
      actor.permissions,
      {
        leadId: input.leadId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        allowDuplicate: input.allowDuplicate,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: member }, { status: 201 });
  },
);
