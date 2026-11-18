import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runBilling } from '@gym/core';

export const dynamic = 'force-dynamic';

/**
 * The daily billing run.
 *
 * Moves trials, raises invoices and puts lapsed gyms read-only. It never
 * suspends and never deletes: read-only is the strongest thing
 * non-payment does, because the records belong to the gym.
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

  const result = await runBilling({});
  return NextResponse.json({ data: result }, { status: 200, headers: { 'cache-control': 'no-store' } });
}
