import { NextResponse } from 'next/server';
import { preferenceInput } from '@gym/contracts';
import { setPreference } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const POST = route(
  { permission: 'comms.preference.manage', schema: preferenceInput },
  async ({ input, actor, ipAddress }) => {
    await setPreference(
      tenantOf(actor),
      actor.permissions,
      {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        channel: input.channel,
        category: input.category,
        optedIn: input.optedIn,
        source: input.source,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: { saved: true } });
  },
);
