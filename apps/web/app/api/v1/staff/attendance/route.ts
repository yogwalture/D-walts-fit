import { NextResponse } from 'next/server';
import { staffAttendanceInput, staffDayQuery } from '@gym/contracts';
import { markStaffAttendance, staffDay } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'staff.attendance.read', source: 'query', schema: staffDayQuery },
  async ({ input, actor }) => {
    const day = await staffDay(tenantOf(actor), actor.permissions, { date: input.date });
    return NextResponse.json({ data: day.rows, meta: { date: day.date } });
  },
);

export const POST = route(
  { permission: 'staff.attendance.manage', schema: staffAttendanceInput },
  async ({ input, actor, ipAddress }) => {
    const result = await markStaffAttendance(
      tenantOf(actor),
      actor.permissions,
      {
        orgUserId: input.orgUserId,
        date: input.date,
        status: input.status,
        action: input.action,
        notes: input.notes,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
