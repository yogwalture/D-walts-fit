import { NextResponse } from 'next/server';
import { checkOutInput } from '@gym/contracts';
import { checkOut } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'attendance.checkin.create', schema: checkOutInput },
  async ({ input, actor }) => {
    const result = await checkOut(tenantOf(actor), actor.permissions, input);
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
