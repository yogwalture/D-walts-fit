import { NextResponse } from 'next/server';
import { memberPayments } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'self.payment.read' }, async ({ actor }) => {
  const result = await memberPayments(memberContextOf(actor), actor.permissions, {});
  return NextResponse.json({ data: result.rows, meta: { outstanding: result.outstanding } });
});
