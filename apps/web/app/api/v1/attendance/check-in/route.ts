import { NextResponse } from 'next/server';
import { checkInInput } from '@gym/contracts';
import { checkIn } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The busiest endpoint in the product: forty people in twenty minutes at
 * 6 a.m., one receptionist, one phone.
 *
 * A refusal is a 200 carrying `allowed: false` and the reason, not an error
 * status — the desk needs the member's name and photo on screen to tell them
 * why, and an error body would throw that away.
 */
export const POST = route(
  { permission: 'attendance.checkin.create', schema: checkInInput },
  async ({ input, actor, ipAddress }) => {
    const result = await checkIn(tenantOf(actor), actor.permissions, input, {
      ipAddress,
      deviceLabel: input.deviceLabel,
    });
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
