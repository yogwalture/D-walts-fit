import { NextResponse } from 'next/server';
import { bookClassInput, cancelBookingInput } from '@gym/contracts';
import { bookClass, cancelBooking } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'classes.booking.manage', schema: bookClassInput },
  async ({ input, actor, ipAddress }) => {
    const result = await bookClass(
      tenantOf(actor),
      actor.permissions,
      {
        classId: input.classId,
        memberId: input.memberId,
        allowIneligible: input.allowIneligible,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);

/**
 * Cancelling returns whoever moved off the waitlist, because the next thing
 * that has to happen is telling them.
 */
export const DELETE = route(
  { permission: 'classes.booking.manage', schema: cancelBookingInput },
  async ({ input, actor, ipAddress }) => {
    const result = await cancelBooking(
      tenantOf(actor),
      actor.permissions,
      { bookingId: input.bookingId, reason: input.reason },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);
