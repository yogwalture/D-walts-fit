import { NextResponse } from 'next/server';
import { z } from 'zod';
import { boolish, pageQuery } from '@gym/contracts';
import { listAudit } from '@gym/core';
import { route, paged } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * A gym reading its own audit log, including everything the vendor did on
 * their account. `platformOnly=true` is the view that answers "has anybody
 * from the software company been in here?".
 */
export const GET = route(
  {
    permission: 'org.audit.read',
    source: 'query',
    schema: pageQuery.extend({
      platformOnly: boolish.default(false),
      action: z.string().trim().max(80).optional(),
      entityType: z.string().trim().max(60).optional(),
    }),
  },
  async ({ input, actor }) => {
    const { rows, total } = await listAudit(tenantOf(actor), actor.permissions, {
      page: input.page,
      pageSize: input.pageSize,
      platformOnly: input.platformOnly,
      action: input.action,
      entityType: input.entityType,
    });

    return NextResponse.json(paged(rows, total, input.page, input.pageSize));
  },
);
