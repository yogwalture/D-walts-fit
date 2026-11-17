import { NextResponse } from 'next/server';
import { paymentListQuery, recordPaymentInput } from '@gym/contracts';
import { listPayments, recordPayment } from '@gym/core';
import { route, paged } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'finance.payment.read', source: 'query', schema: paymentListQuery },
  async ({ input, actor }) => {
    const { rows, total } = await listPayments(tenantOf(actor), actor.permissions, input);
    return NextResponse.json(paged(rows, total, input.page, input.pageSize), { status: 200 });
  },
);

/**
 * Takes a payment at the counter.
 *
 * Cash, UPI, card machine, cheque — all recorded the same way, with a
 * receipt number allocated from the gym's own gapless sequence. Gateway
 * payments do NOT come through here: they are only ever marked captured by
 * the webhook, after its signature has been verified server-side.
 */
export const POST = route(
  { permission: 'finance.payment.create', schema: recordPaymentInput },
  async ({ input, actor, ipAddress }) => {
    const result = await recordPayment(tenantOf(actor), actor.permissions, input, { ipAddress });
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
