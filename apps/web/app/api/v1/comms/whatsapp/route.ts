import { NextResponse } from 'next/server';
import { whatsappSettingsInput } from '@gym/contracts';
import { disconnectWhatsapp, getWhatsappSettings, saveWhatsappSettings } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** The token is never returned — only its last four characters. */
export const GET = route({ permission: 'comms.template.read' }, async ({ actor }) => {
  const settings = await getWhatsappSettings(tenantOf(actor), actor.permissions);
  return NextResponse.json({ data: settings });
});

export const POST = route(
  { permission: 'comms.template.manage', schema: whatsappSettingsInput },
  async ({ input, actor, ipAddress }) => {
    const result = await saveWhatsappSettings(
      tenantOf(actor),
      actor.permissions,
      {
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        accessToken: input.accessToken,
        businessName: input.businessName,
        webhookVerifyToken: input.webhookVerifyToken,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result });
  },
);

export const DELETE = route(
  { permission: 'comms.template.manage' },
  async ({ actor, ipAddress }) => {
    await disconnectWhatsapp(tenantOf(actor), actor.permissions, { ipAddress });
    return NextResponse.json({ data: { disconnected: true } });
  },
);
