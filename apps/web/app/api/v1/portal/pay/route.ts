import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startOnlinePayment, confirmOnlinePayment, AppError } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';
import { razorpayPort } from '@/lib/razorpay-port';

export const dynamic = 'force-dynamic';

/**
 * A member paying their own dues.
 *
 * The member id comes from the session, never from the request, and the
 * service checks the invoice belongs to them — so there is no input through
 * which to pay, or look at, somebody else's invoice.
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
  { permission: 'self.payment.create', schema: body },
  async ({ input, actor }) => {
    const ctx = memberContextOf(actor);
    if (!ctx.memberId) {
      throw new AppError('FORBIDDEN', 'Sign in as a member to pay an invoice.');
    }

    if (input.action === 'start') {
      const started = await startOnlinePayment(
        ctx,
        { invoiceId: input.invoiceId, memberId: ctx.memberId },
        razorpayPort,
      );
      return NextResponse.json({ data: started }, { status: 201 });
    }

    const result = await confirmOnlinePayment(
      ctx,
      {
        orderId: input.orderId,
        razorpayPaymentId: input.razorpayPaymentId,
        signature: input.signature,
        memberId: ctx.memberId,
      },
      razorpayPort,
    );
    return NextResponse.json({ data: result });
  },
);
