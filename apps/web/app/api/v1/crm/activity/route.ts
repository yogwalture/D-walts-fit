import { NextResponse } from 'next/server';
import { logActivityInput } from '@gym/contracts';
import { logActivity } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** A call and its next follow-up, together — see the contract for why. */
export const POST = route(
  { permission: 'crm.followup.manage', schema: logActivityInput },
  async ({ input, actor, ipAddress }) => {
    const lead = await logActivity(
      tenantOf(actor),
      actor.permissions,
      {
        leadId: input.leadId,
        activityType: input.activityType,
        outcome: input.outcome,
        notes: input.notes,
        nextFollowUpAt: input.nextFollowUpAt,
        status: input.status,
      },
      { ipAddress },
    );
    // The new follow-up date, so a caller that logged a call knows when the
    // next one is due without asking again.
    return NextResponse.json({ data: lead }, { status: 201 });
  },
);
