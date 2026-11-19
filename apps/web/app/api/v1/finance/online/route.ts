import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  startOnlinePayment,
  confirmOnlinePayment,
  onlinePaymentAvailability,
} from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';
import { razorpayPort } from '@/lib/razorpay-port';

export const dynamic = 'force-dynamic';

/** Whether this gym can take a payment online at all. */
export const GET = route({ permission: 'finance.payment.read' }, async ({ actor }) => {
  const availability = await onlinePaymentAvailability(tenantOf(actor), actor.permissions);
  return NextResponse.json({ data: availability });
});

/**
 * Start or confirm an online payment from the desk.
 *
 * Confirming does not mean believing: the server re-reads the payment from
 * Razorpay's own API before anything is settled, and the webhook would have
 * settled it anyway.
 */
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), invoiceId: z.string().uuid() }),
  z.object({
    action: z.literal('confirm'),
    orderId: z.string().trim().min(6).max(64),
    razorpayPaymentId: z.string().trim().min(6).max(64),
    signature: z.string().trim().min(16).max(256),
  }),
]);

export const POST = route(
  { permission: 'finance.payment.create', schema: body },
  async ({ input, actor }) => {
    if (input.action === 'start') {
      const started = await startOnlinePayment(
        tenantOf(actor),
        { invoiceId: input.invoiceId },
        razorpayPort,
      );
      return NextResponse.json({ data: started }, { status: 201 });
    }

    const result = await confirmOnlinePayment(
      tenantOf(actor),
      {
        orderId: input.orderId,
        razorpayPaymentId: input.razorpayPaymentId,
        signature: input.signature,
      },
      razorpayPort,
    );
    return NextResponse.json({ data: result });
  },
);
