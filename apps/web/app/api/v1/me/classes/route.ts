import { NextResponse } from 'next/server';
import {
  selfBookClassInput,
  selfCancelBookingInput,
  memberClassQuery,
} from '@gym/contracts';
import { bookClassAsMember, cancelBookingAsMember, memberClassList } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'self.class.read', source: 'query', schema: memberClassQuery },
  async ({ input, actor }) => {
    const rows = await memberClassList(memberContextOf(actor), actor.permissions, {
      days: input.days,
    });
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  { permission: 'self.class.book', schema: selfBookClassInput },
  async ({ input, actor, ipAddress }) => {
    const result = await bookClassAsMember(
      memberContextOf(actor),
      actor.permissions,
      { classId: input.classId },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);

export const DELETE = route(
  { permission: 'self.class.book', schema: selfCancelBookingInput },
  async ({ input, actor, ipAddress }) => {
    const result = await cancelBookingAsMember(
      memberContextOf(actor),
      actor.permissions,
      { bookingId: input.bookingId },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);
