import { NextResponse } from 'next/server';
import { getPlatformStats } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'platform.revenue.read' }, async ({ actor }) => {
  const stats = await getPlatformStats(actor.userId);
  return NextResponse.json({ data: stats }, { status: 200 });
});
