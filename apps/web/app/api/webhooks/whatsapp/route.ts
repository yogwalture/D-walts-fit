import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { applyWhatsappWebhook } from '@gym/core';

export const dynamic = 'force-dynamic';

/**
 * What WhatsApp tells us after the fact: delivery receipts, and STOP.
 *
 * The signature is checked over the **raw** body before anything parses it,
 * for the same reason the Razorpay webhook does: a body verified after
 * parsing is a body verified in a different shape from the one that was
 * signed.
 *
 * The tenant is resolved from the phone number id against our own records,
 * never from anything in the payload a sender could choose.
 */
function signatureValid(raw: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return false;
  if (!header?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const presented = header.slice('sha256='.length);

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Meta's subscription handshake. */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (
    expected &&
    params.get('hub.mode') === 'subscribe' &&
    params.get('hub.verify_token') === expected
  ) {
    return new NextResponse(params.get('hub.challenge') ?? '', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: 'Verification failed.' } },
    { status: 403 },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();

  if (!signatureValid(raw, request.headers.get('x-hub-signature-256'))) {
    // Deliberately terse: an unsigned caller learns nothing about whether
    // the secret is missing or merely wrong.
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Invalid signature.' } },
      { status: 400 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Malformed payload.' } },
      { status: 400 },
    );
  }

  const outcome = await applyWhatsappWebhook(payload);

  // Meta retries anything that is not a 200, so a payload we understood is
  // acknowledged even when it changed nothing.
  return NextResponse.json({ data: outcome }, { status: 200 });
}
