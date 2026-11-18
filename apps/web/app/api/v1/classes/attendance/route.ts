import { NextResponse } from 'next/server';
import { classAttendanceInput } from '@gym/contracts';
import { markAttendance } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'classes.booking.manage', schema: classAttendanceInput },
  async ({ input, actor, ipAddress }) => {
    const result = await markAttendance(
      tenantOf(actor),
      actor.permissions,
      { bookingId: input.bookingId, attended: input.attended },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);
