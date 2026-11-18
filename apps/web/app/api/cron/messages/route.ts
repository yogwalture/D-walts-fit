import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { drainMessageQueue, SEND_BATCH_SIZE } from '@gym/core';

export const dynamic = 'force-dynamic';

/**
 * Sends a batch of queued messages.
 *
 * The deploy target has no background workers, so a scheduler calls this
 * every few minutes. The batch is bounded because the host kills a request
 * at 120 seconds, and a batch that does not finish is a batch whose outcome
 * nobody recorded.
 *
 * Guarded by a shared secret compared in constant time, and never reachable
 * with a session: this runs across tenants, which no request carrying a
 * user's session is ever allowed to do.
 */
function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Lengths must match before timingSafeEqual, and a length mismatch is
  // itself a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Not authorised.' } },
      { status: 401 },
    );
  }

  const limit = Number(new URL(request.url).searchParams.get('limit') ?? SEND_BATCH_SIZE);
  const result = await drainMessageQueue({ limit: Number.isFinite(limit) ? limit : undefined });

  return NextResponse.json(
    {
      data: {
        ...result,
        // Named rather than counted: "3 gyms are holding messages" is not
        // something anybody can act on.
        heldOrganizations: result.heldReasons.length,
      },
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/** A GET says what is waiting without sending anything. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Not authorised.' } },
      { status: 401 },
    );
  }

  const { getJobsClient } = await import('@gym/db');
  const queued = await getJobsClient().message.count({ where: { status: 'QUEUED' } });

  return NextResponse.json(
    { data: { queued, batchSize: SEND_BATCH_SIZE } },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
