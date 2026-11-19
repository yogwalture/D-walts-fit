import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getJobsClient } from '@gym/db';
import { runHousekeeping, housekeepingPending } from '@gym/core';

export const dynamic = 'force-dynamic';

/**
 * The daily tidy-up: expired tokens, dead sessions, old login attempts and
 * spent throttle counters.
 *
 * None of it holds anything of value after a few days, and all of it grows
 * with traffic. `purgeExpiredTokens` carried a comment saying it was run by
 * a daily job that did not exist, which is how a table ends up only ever
 * getting bigger.
 *
 * Bounded per pass, so a backlog is cleared over several runs rather than
 * one request being cut off at the host's 120-second limit.
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

  const result = await runHousekeeping(getJobsClient());

  return NextResponse.json(
    { data: result },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/** A GET says what is waiting without removing anything. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Not authorised.' } },
      { status: 401 },
    );
  }

  const pending = await housekeepingPending(getJobsClient());

  return NextResponse.json(
    { data: pending },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
