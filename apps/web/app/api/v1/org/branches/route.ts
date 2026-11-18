import { NextResponse } from 'next/server';
import { branchInput } from '@gym/contracts';
import { createBranch, listBranches } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'org.branch.read' }, async ({ actor }) => {
  const rows = await listBranches(tenantOf(actor), actor.permissions);
  return NextResponse.json({ data: rows });
});

/** The plan's branch limit is enforced in the service, not here. */
export const POST = route(
  { permission: 'org.branch.create', schema: branchInput },
  async ({ input, actor, ipAddress }) => {
    const branch = await createBranch(
      tenantOf(actor),
      actor.permissions,
      {
        name: input.name,
        code: input.code,
        city: input.city,
        addressLine1: input.addressLine1,
        phone: input.phone,
        timezone: input.timezone,
        openingTime: input.openingTime,
        closingTime: input.closingTime,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: branch }, { status: 201 });
  },
);
