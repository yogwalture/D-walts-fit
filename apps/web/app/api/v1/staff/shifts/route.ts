import { NextResponse } from 'next/server';
import { shiftInput } from '@gym/contracts';
import { listShifts, removeShift, setShift } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'staff.attendance.read' },
  async ({ request, actor }) => {
    const orgUserId = new URL(request.url).searchParams.get('orgUserId') ?? undefined;
    const rows = await listShifts(tenantOf(actor), actor.permissions, { orgUserId });
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  { permission: 'staff.shift.manage', schema: shiftInput },
  async ({ input, actor, ipAddress }) => {
    const result = await setShift(
      tenantOf(actor),
      actor.permissions,
      {
        orgUserId: input.orgUserId,
        weekday: input.weekday,
        shiftDate: input.shiftDate,
        startTime: input.startTime,
        endTime: input.endTime,
        notes: input.notes,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);

export const DELETE = route(
  { permission: 'staff.shift.manage', schema: z.object({ shiftId: z.string().uuid() }) },
  async ({ input, actor, ipAddress }) => {
    await removeShift(tenantOf(actor), actor.permissions, input.shiftId, { ipAddress });
    return NextResponse.json({ data: { removed: true } });
  },
);
