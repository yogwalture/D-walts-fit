import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGatewaySettings, saveGatewaySettings, setGatewayEnabled } from '@gym/core';
import { fetchOrders } from '@gym/integrations';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'org.integration.read' }, async ({ actor }) => {
  const settings = await getGatewaySettings(tenantOf(actor), actor.permissions);
  return NextResponse.json({ data: settings });
});

const body = z.union([
  z.object({
    keyId: z.string().trim().min(10).max(80),
    keySecret: z.string().trim().min(10).max(200),
    webhookSecret: z.string().trim().min(8).max(200),
  }),
  z.object({ isEnabled: z.boolean() }),
]);

/**
 * Connecting a gym's own Razorpay account, or switching it off.
 *
 * Verified by a read against Razorpay before it is stored as connected —
 * listing orders authenticates the key pair without moving a rupee. A
 * "connected" badge earned any other way is a guess, and the person who
 * meets the guess is a member tapping Pay.
 */
export const POST = route(
  { permission: 'org.integration.update', schema: body },
  async ({ input, actor, ipAddress }) => {
    if ('isEnabled' in input) {
      await setGatewayEnabled(tenantOf(actor), actor.permissions, input.isEnabled, { ipAddress });
      const settings = await getGatewaySettings(tenantOf(actor), actor.permissions);
      return NextResponse.json({ data: settings });
    }

    const settings = await saveGatewaySettings(
      tenantOf(actor),
      actor.permissions,
      input,
      { ipAddress, verify: (config) => fetchOrders(config) },
    );
    return NextResponse.json({ data: settings });
  },
);
