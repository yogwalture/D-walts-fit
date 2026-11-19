import { NextResponse } from 'next/server';
import { getJobsClient } from '@gym/db';
import {
  applyVerifiedGatewayPayment,
  markGatewayPaymentFailed,
  gatewayByWebhookId,
} from '@gym/core';
import { parseWebhook } from '@gym/integrations';

/**
 * One gym's Razorpay webhook. The only thing that may mark that gym's
 * gateway payments captured.
 *
 * Each gym collects into their own Razorpay account, so each has their own
 * signing secret and therefore their own webhook URL. The id in the path is
 * opaque and random, and it decides nothing: it selects *which* gym's secret
 * to check the HMAC against. A request that cannot produce a valid signature
 * for that gym is refused, and even a valid one cannot name the tenant — the
 * ledger write is scoped by our own order row.
 *
 * Everything else is as the platform webhook:
 *
 *   1. The raw body is read as text and verified BEFORE anything parses it.
 *   2. A browser saying "payment succeeded" is never believed here or
 *      anywhere. This endpoint updates the ledger; the browser updates a
 *      screen.
 *   3. Applying is idempotent on the order id, because Razorpay retries any
 *      non-2xx and a payment must not be bankable twice.
 *   4. A verified-but-unrecognised event returns 200, or Razorpay would
 *      retry it forever.
 *
 * It has no session, so it uses the jobs client.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ webhookId: string }> },
): Promise<NextResponse> {
  const { webhookId } = await context.params;

  const credentials = await gatewayByWebhookId(webhookId);
  if (!credentials) {
    // Unknown id, or the gym's gateway is switched off. Deliberately the
    // same answer either way: a probe learns nothing about which gyms exist.
    return NextResponse.json({ received: false }, { status: 404 });
  }

  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature');

  let event;
  try {
    event = parseWebhook(credentials, raw, signature);
  } catch (error) {
    console.warn('[razorpay] rejected an unverifiable webhook:', (error as Error).message);
    return NextResponse.json({ received: false }, { status: 400 });
  }

  if (!event.orderId) {
    return NextResponse.json({ received: true, matched: false }, { status: 200 });
  }

  const jobs = getJobsClient();

  try {
    // Which gym does this order belong to? Our row decides — and it must
    // agree with the gym whose secret just verified the signature. A
    // mismatch would mean one gym's credentials settling another's invoice.
    const owner = await jobs.payment.findFirst({
      where: { razorpayOrderId: event.orderId },
      select: { organizationId: true },
    });

    if (!owner) {
      console.warn('[razorpay] verified webhook for an unknown order', event.orderId);
      return NextResponse.json({ received: true, matched: false }, { status: 200 });
    }

    if (owner.organizationId !== credentials.organizationId) {
      console.error('[razorpay] a gym’s webhook carried another gym’s order', {
        webhookId,
        orderId: event.orderId,
      });
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
        break;
    }
  } catch (error) {
    // Our fault: a 500 asks Razorpay to retry, which is what we want.
    console.error('[razorpay] failed to apply a verified webhook', error);
    return NextResponse.json({ received: false }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
