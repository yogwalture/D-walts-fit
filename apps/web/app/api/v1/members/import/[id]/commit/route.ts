import { NextResponse } from 'next/server';
import { z } from 'zod';
import { commitImport } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const body = z.object({
  skipRows: z.array(z.number().int().min(0)).max(20_000).default([]),
  includeDuplicates: z.boolean().default(false),
  /**
   * Rows per call. The client keeps calling while `hasMore` is true, so a
   * large file imports in several short requests rather than one that
   * Hostinger would kill at 120 seconds.
   */
  batchSize: z.number().int().min(1).max(500).default(200),
});

export const POST = route(
  { permission: 'members.member.create', schema: body },
  async ({ input, actor, params, ipAddress }) => {
    const result = await commitImport(
      tenantOf(actor),
      actor.permissions,
      {
        importId: params.id!,
        skipRows: input.skipRows,
        includeDuplicates: input.includeDuplicates,
        batchSize: input.batchSize,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 200 });
  },
);
