import { NextResponse } from 'next/server';
import { timetableQuery } from '@gym/contracts';
import { listClasses } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'classes.class.read', source: 'query', schema: timetableQuery },
  async ({ input, actor }) => {
    const result = await listClasses(tenantOf(actor), actor.permissions, {
      from: input.from,
      to: input.to,
      branchId: input.branchId,
      classTypeId: input.classTypeId,
      trainerOrgUserId: input.trainerOrgUserId,
      includeCancelled: input.includeCancelled,
    });
    return NextResponse.json({ data: result.rows, meta: { from: result.from, to: result.to } });
  },
);
