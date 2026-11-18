import { NextResponse } from 'next/server';
import { memberVisits } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'self.attendance.read' }, async ({ request, actor }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 60) || 60;
  const result = await memberVisits(memberContextOf(actor), actor.permissions, { limit });
  return NextResponse.json({ data: result.rows, meta: { streak: result.streak } });
});
