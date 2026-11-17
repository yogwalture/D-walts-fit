import { NextResponse } from 'next/server';
import { switchOrganizationInput } from '@gym/contracts';
import { resolveSession, switchOrganization, writeAudit } from '@gym/core';
import { withTenant } from '@gym/db';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { readBearerToken, readSessionToken } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * Switching the acting gym.
 *
 * The membership is verified server-side against org_users, the session row
 * is rewritten, and the switch is audited inside the gym being entered.
 * There is no client-side path to a different tenant: editing a URL or a
 * cookie value changes nothing, because tenancy is read from this row and
 * nowhere else.
 */
export const POST = route(
  { schema: switchOrganizationInput },
  async ({ input, actor, request, ipAddress, userAgent }) => {
    const db = basePrismaForAuth();

    await switchOrganization(db, {
      sessionId: actor.sessionId,
      userId: actor.userId,
      organizationId: input.organizationId,
    });

    await withTenant(
      { organizationId: input.organizationId, userId: actor.userId },
      async (tx) =>
        writeAudit(tx, {
          organizationId: input.organizationId,
          actorUserId: actor.userId,
          action: 'session.organization.switched',
          entityType: 'Session',
          entityId: actor.sessionId,
          summary: 'Switched into this gym',
          ipAddress,
          userAgent,
        }),
    );

    // Re-resolve so the response carries the new role and permission set,
    // and the client can repaint without a second round trip.
    const token = readBearerToken(request) ?? (await readSessionToken());
    const { view } = await resolveSession(db, token!);

    return NextResponse.json({ data: view }, { status: 200 });
  },
);
