import { NextResponse } from 'next/server';
import { assignTrainerInput } from '@gym/contracts';
import { assignTrainer } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Assigns a member to a trainer, or takes them off one with a null. */
export const POST = route(
  { permission: 'members.member.update', schema: assignTrainerInput },
  async ({ input, actor, ipAddress }) => {
    await assignTrainer(
      tenantOf(actor),
      actor.permissions,
      {
        memberId: input.memberId,
        orgUserId: input.orgUserId ?? null,
        notes: input.notes,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: { assigned: true } }, { status: 200 });
  },
);
