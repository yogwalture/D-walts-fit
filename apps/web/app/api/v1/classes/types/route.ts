import { NextResponse } from 'next/server';
import { classTypeInput } from '@gym/contracts';
import { createClassType, listClassTypes } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'classes.class.read' },
  async ({ request, actor }) => {
    const includeInactive =
      new URL(request.url).searchParams.get('includeInactive') === 'true';
    const rows = await listClassTypes(tenantOf(actor), actor.permissions, { includeInactive });
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  { permission: 'classes.class.manage', schema: classTypeInput },
  async ({ input, actor, ipAddress }) => {
    const created = await createClassType(
      tenantOf(actor),
      actor.permissions,
      {
        name: input.name,
        description: input.description,
        defaultDurationMinutes: input.defaultDurationMinutes,
        defaultCapacity: input.defaultCapacity,
        colorHex: input.colorHex,
        requiresBooking: input.requiresBooking,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: created }, { status: 201 });
  },
);
