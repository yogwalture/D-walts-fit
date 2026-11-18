import { NextResponse } from 'next/server';
import { memberHome } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * Everything on a member's own page.
 *
 * No member id in the request, by design: it comes from the session, so
 * there is nothing here for a crafted URL to substitute.
 */
export const GET = route({ permission: 'self.membership.read' }, async ({ actor }) => {
  const home = await memberHome(memberContextOf(actor), actor.permissions);
  return NextResponse.json({ data: home });
});
