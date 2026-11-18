import { NextResponse } from 'next/server';
import { audienceFilter, campaignInput } from '@gym/contracts';
import { listCampaigns, queueCampaign, resolveAudience } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'comms.history.read' }, async ({ actor }) => {
  const rows = await listCampaigns(tenantOf(actor), actor.permissions, {});
  return NextResponse.json({ data: rows });
});

/**
 * Queues a campaign. Nothing is sent in this request: a gym pressing Send
 * and waiting while four hundred provider calls happen is a gym staring at
 * a timeout.
 */
export const POST = route(
  { permission: 'comms.campaign.create', schema: campaignInput },
  async ({ input, actor, ipAddress }) => {
    const result = await queueCampaign(
      tenantOf(actor),
      actor.permissions,
      {
        name: input.name,
        templateId: input.templateId,
        audience: input.audience,
        scheduledAt: input.scheduledAt,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);

/** How many a campaign would reach — asked before anything is queued. */
export const PUT = route(
  { permission: 'comms.message.send', schema: audienceFilter },
  async ({ input, actor }) => {
    const recipients = await resolveAudience(tenantOf(actor), actor.permissions, input);
    return NextResponse.json({
      data: {
        count: recipients.length,
        sample: recipients.slice(0, 5).map((r) => ({ name: r.name, phone: r.phone })),
      },
    });
  },
);
