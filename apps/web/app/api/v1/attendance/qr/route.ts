import { NextResponse } from 'next/server';
import { issueQrInput } from '@gym/contracts';
import { AppError, issueBranchQr, issueMemberQr } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Issues a rotating QR token.
 *
 * Issuing revokes the previous one, so a screenshot of an old code stops
 * working — which is the whole point of the code being rotatable.
 */
export const POST = route(
  { permission: 'attendance.checkin.create', schema: issueQrInput },
  async ({ input, actor }) => {
    const ctx = tenantOf(actor);

    if (input.memberId) {
      return NextResponse.json(
        { data: await issueMemberQr(ctx, { memberId: input.memberId }) },
        { status: 201 },
      );
    }

    if (input.branchId) {
      return NextResponse.json(
        { data: await issueBranchQr(ctx, actor.permissions, { branchId: input.branchId }) },
        { status: 201 },
      );
    }

    throw new AppError('VALIDATION_FAILED', 'Name either a member or a branch.');
  },
);
