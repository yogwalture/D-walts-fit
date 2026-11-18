import { NextResponse } from 'next/server';
import { leaveDecisionInput, leaveListQuery, leaveRequestInput } from '@gym/contracts';
import { decideLeave, listLeave, requestLeave } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'staff.leave.read', source: 'query', schema: leaveListQuery },
  async ({ input, actor }) => {
    const rows = await listLeave(tenantOf(actor), actor.permissions, {
      status: input.status,
      orgUserId: input.orgUserId,
      limit: input.limit,
    });
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  { permission: 'staff.leave.read', schema: leaveRequestInput },
  async ({ input, actor, ipAddress }) => {
    const leave = await requestLeave(
      tenantOf(actor),
      actor.permissions,
      {
        orgUserId: input.orgUserId,
        leaveType: input.leaveType,
        fromDate: input.fromDate,
        toDate: input.toDate,
        reason: input.reason,
        halfDay: input.halfDay,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: leave }, { status: 201 });
  },
);

/** Approving writes the attendance for those days — see the service. */
export const PATCH = route(
  { permission: 'staff.leave.approve', schema: leaveDecisionInput },
  async ({ input, actor, ipAddress }) => {
    const result = await decideLeave(
      tenantOf(actor),
      actor.permissions,
      { leaveId: input.leaveId, approve: input.approve, note: input.note },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);
