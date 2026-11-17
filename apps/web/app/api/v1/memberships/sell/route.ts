import { NextResponse } from 'next/server';
import { sellMembershipInput } from '@gym/contracts';
import { sellMembership } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Sells or renews a membership.
 *
 * Subscription, invoice, invoice lines, the payment and the member's
 * denormalised expiry all land in one transaction. A half-sold membership —
 * money taken, no subscription — is not a state this endpoint can produce.
 *
 * Fields are mapped one by one: they are nearly all optional on the service's
 * side, so a spread would let a renamed field be dropped in silence and a
 * discount quietly not apply.
 */
export const POST = route(
  { permission: 'memberships.subscription.create', schema: sellMembershipInput },
  async ({ input, actor, ipAddress }) => {
    const sale = await sellMembership(
      tenantOf(actor),
      actor.permissions,
      {
        memberId: input.memberId,
        planId: input.planId,
        branchId: input.branchId,
        startDate: input.startDate,
        discountCode: input.discountCode,
        overridePrice: input.overridePrice,
        payment: input.payment
          ? {
              amount: input.payment.amount,
              method: input.payment.method,
              referenceNumber: input.payment.referenceNumber,
              receivedAt: input.payment.receivedAt,
            }
          : undefined,
        notes: input.notes,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: sale }, { status: 201 });
  },
);
