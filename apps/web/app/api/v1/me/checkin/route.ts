import { NextResponse } from 'next/server';
import { selfCheckInInput } from '@gym/contracts';
import { selfCheckIn } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * A member checking themselves in by scanning the code at the entrance.
 *
 * The same eligibility rules as the front desk: a membership that would be
 * refused at the door is refused here. An app that waved people past an
 * expired membership would be worse than no app.
 */
export const POST = route(
  { permission: 'self.attendance.checkin', schema: selfCheckInInput },
  async ({ input, actor }) => {
    const result = await selfCheckIn(memberContextOf(actor), actor.permissions, {
      code: input.code,
    });
    return NextResponse.json({ data: result }, { status: result.allowed ? 201 : 200 });
  },
);
