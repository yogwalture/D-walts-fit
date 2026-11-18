import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { queueExpiryReminders } from '@gym/core';

export const dynamic = 'force-dynamic';

/**
 * The expiry reminders, queued once a day.
 *
 * A membership that lapses unnoticed is revenue a gym never sees again, and
 * the reminder nobody sent is the commonest reason it lapses. Queueing is
 * idempotent on the member, the subscription and the day, so a scheduler
 * that fires twice cannot message anybody twice.
 */
function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Not authorised.' } },
      { status: 401 },
    );
  }

  const daysAhead = Number(new URL(request.url).searchParams.get('daysAhead') ?? 7);
  const run = await queueExpiryReminders({
    daysAhead: Number.isFinite(daysAhead) ? daysAhead : 7,
  });

  return NextResponse.json({ data: run }, { status: 200, headers: { 'cache-control': 'no-store' } });
}
