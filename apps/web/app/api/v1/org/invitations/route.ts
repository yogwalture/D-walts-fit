import { listPendingInvitations } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Who has been invited and not yet accepted. */
export const GET = route({ permission: 'org.user.read' }, async ({ actor }) =>
  listPendingInvitations(tenantOf(actor), actor.permissions),
);
