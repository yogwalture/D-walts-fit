import { NextResponse } from 'next/server';
import { scheduleClassInput } from '@gym/contracts';
import { scheduleClass } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Puts a class on the timetable. A repeat that clashes on one of its weeks
 * returns the sessions it could create and the ones it skipped, with
 * reasons — generating a term should not fail over one busy evening.
 */
export const POST = route(
  { permission: 'classes.class.manage', schema: scheduleClassInput },
  async ({ input, actor, ipAddress }) => {
    const result = await scheduleClass(
      tenantOf(actor),
      actor.permissions,
      {
        classTypeId: input.classTypeId,
        branchId: input.branchId,
        trainerOrgUserId: input.trainerOrgUserId,
        title: input.title,
        startsAt: input.startsAt,
        durationMinutes: input.durationMinutes,
        capacity: input.capacity,
        room: input.room,
        notes: input.notes,
        repeatOn: input.repeatOn,
        repeatWeeks: input.repeatWeeks,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
