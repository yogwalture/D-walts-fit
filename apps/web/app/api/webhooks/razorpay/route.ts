import { NextResponse } from 'next/server';
import { getJobsClient } from '@gym/db';
import { applyVerifiedGatewayPayment, markGatewayPaymentFailed } from '@gym/core';
import { getRazorpayConfig, parseWebhook } from '@gym/integrations';

/**
 * Razorpay's webhook. The only thing in the product that may mark a gateway
 * payment captured.
 *
 * The rules this route exists to enforce:
 *
 *   1. The raw body is read as text and the HMAC checked BEFORE anything is
 *      parsed. Re-serialised JSON has different bytes and would not verify,
 *      so the raw bytes are the only thing the signature is computed over.
 *   2. A browser saying "payment succeeded" is never believed. The client's
 *      checkout callback updates the UI; this endpoint updates the ledger.
 *   3. The tenant is read from OUR stored order row, never from the request.
 *      Razorpay does not know our gyms, and a webhook must not be able to
 *      name one.
 *   4. Applying is idempotent on the order id. Razorpay retries on any
 *      non-2xx, so a payment must not be bankable twice.
 *   5. A verified-but-unrecognised event still returns 200. Returning an
 *      error would have Razorpay retry it forever.
 *
 * It runs outside the session middleware — it has no session — and so uses
 * the jobs client, which bypasses row-level security.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const config = getRazorpayConfig();
  if (!config) {
    console.error('[razorpay] webhook received but no credentials are configured');
    return NextResponse.json({ received: false }, { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature');

  let event;
  try {
    event = parseWebhook(config, raw, signature);
  } catch (error) {
    // A bad signature is either a misconfiguration or someone trying it on.
    // 400, no detail, and Razorpay will not retry a 400.
    console.warn('[razorpay] rejected an unverifiable webhook:', (error as Error).message);
    return NextResponse.json({ received: false }, { status: 400 });
  }

  if (!event.orderId) {
    // Verified, but nothing we can match to an invoice.
    return NextResponse.json({ received: true, matched: false }, { status: 200 });
  }

  const jobs = getJobsClient();

  try {
    // Which gym does this order belong to? Our row decides.
    const owner = await jobs.payment.findFirst({
      where: { razorpayOrderId: event.orderId },
      select: { organizationId: true },
    });

    if (!owner) {
      console.warn('[razorpay] verified webhook for an unknown order', event.orderId);
      return NextResponse.json({ received: true, matched: false }, { status: 200 });
    }

    switch (event.event) {
      case 'payment.captured': {
        if (!event.paymentId || typeof event.amount !== 'number') {
          return NextResponse.json({ received: true, matched: false }, { status: 200 });
        }

        const result = await applyVerifiedGatewayPayment(jobs, {
          organizationId: owner.organizationId,
          razorpayPaymentId: event.paymentId,
          razorpayOrderId: event.orderId,
          amountPaise: event.amount,
          method: event.method,
          payload: event.raw,
        });

        if (!result.applied && result.reason !== 'already_captured') {
          // Verified, but it does not match what we issued. Worth an alert,
          // not a retry: retrying will not make the amounts agree.
          console.error('[razorpay] verified payment not applied', {
            orderId: event.orderId,
            reason: result.reason,
          });
        }
        break;
      }

      case 'payment.failed': {
        await markGatewayPaymentFailed(jobs, {
          razorpayOrderId: event.orderId,
          reason: event.errorDescription,
        });
        break;
      }

      default:
        // Verified and genuine, just not an event we act on.
        break;
    }
  } catch (error) {
    // Our fault: a 500 asks Razorpay to retry, which is what we want.
    console.error('[razorpay] failed to apply a verified webhook', error);
    return NextResponse.json({ received: false }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
