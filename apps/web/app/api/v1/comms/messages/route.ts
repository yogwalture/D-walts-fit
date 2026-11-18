import { NextResponse } from 'next/server';
import { listMessages } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'comms.history.read' }, async ({ request, actor }) => {
  const params = new URL(request.url).searchParams;
  const rows = await listMessages(tenantOf(actor), actor.permissions, {
    jobId: params.get('jobId') ?? undefined,
    status: (params.get('status') as never) ?? undefined,
    limit: Number(params.get('limit') ?? 50) || 50,
  });
  return NextResponse.json({ data: rows });
});
