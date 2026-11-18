import { NextResponse } from 'next/server';
import { bookTrialInput, trialOutcomeInput } from '@gym/contracts';
import { bookTrial, recordTrialOutcome } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'crm.followup.manage', schema: bookTrialInput },
  async ({ input, actor, ipAddress }) => {
    const booking = await bookTrial(
      tenantOf(actor),
      actor.permissions,
      {
        leadId: input.leadId,
        scheduledFor: input.scheduledFor,
        trainerOrgUserId: input.trainerOrgUserId,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: booking }, { status: 201 });
  },
);

/** Did they turn up? The number that says whether trials are worth running. */
export const PATCH = route(
  { permission: 'crm.followup.manage', schema: trialOutcomeInput },
  async ({ input, actor }) => {
    await recordTrialOutcome(tenantOf(actor), actor.permissions, {
      bookingId: input.bookingId,
      attended: input.attended,
      feedback: input.feedback,
    });
    return NextResponse.json({ data: { recorded: true } }, { status: 200 });
  },
);
