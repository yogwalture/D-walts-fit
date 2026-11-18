import { NextResponse } from 'next/server';
import { reportExportQuery } from '@gym/contracts';
import {
  collectionsReport,
  taxReport,
  outstandingDues,
  membershipReport,
  businessDayIso,
} from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'finance.report.read', source: 'query', schema: reportExportQuery },
  async ({ input, actor }) => {
    const ctx = tenantOf(actor);
    const from = input.from ?? businessDayIso();
    const to = input.to ?? businessDayIso();

    switch (input.kind) {
      case 'collections':
        return NextResponse.json({
          data: await collectionsReport(ctx, actor.permissions, {
            from,
            to,
            branchId: input.branchId,
          }),
        });
      case 'tax':
        return NextResponse.json({
          data: await taxReport(ctx, actor.permissions, { from, to }),
        });
      case 'dues':
        return NextResponse.json({
          data: await outstandingDues(ctx, actor.permissions, { branchId: input.branchId }),
        });
      case 'memberships':
        return NextResponse.json({
          data: await membershipReport(ctx, actor.permissions, {
            from,
            to,
            branchId: input.branchId,
          }),
        });
    }
  },
);
