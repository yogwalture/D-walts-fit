import { NextResponse } from 'next/server';
import { cancelClassInput } from '@gym/contracts';
import { cancelClass } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Cancels a class, or the rest of its series, and returns the members who
 * have to be told — one entry per person, not per session.
 */
export const POST = route(
  { permission: 'classes.class.manage', schema: cancelClassInput },
  async ({ input, actor, ipAddress }) => {
    const result = await cancelClass(
      tenantOf(actor),
      actor.permissions,
      { classId: input.classId, reason: input.reason, wholeSeries: input.wholeSeries },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);
