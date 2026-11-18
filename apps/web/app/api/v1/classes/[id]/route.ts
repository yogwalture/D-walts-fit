import { NextResponse } from 'next/server';
import { getClass } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'classes.class.read' },
  async ({ actor, params }) => {
    const detail = await getClass(tenantOf(actor), actor.permissions, params.id!);
    return NextResponse.json({ data: detail });
  },
);
