import { NextResponse } from 'next/server';
import { getGymDetail } from '@gym/core';
import { route } from '@/lib/handler';

export const dynamic = 'force-dynamic';

/**
 * One gym, commercially: plan, price, usage against limits, our invoices to
 * them. Not their members, payments or messages — those need an audited
 * tenant entry, which is a different route.
 */
export const GET = route({ permission: 'platform.gym.read' }, async ({ actor, params }) => {
  const detail = await getGymDetail(actor.userId, params.id!);
  return NextResponse.json({ data: detail });
});
