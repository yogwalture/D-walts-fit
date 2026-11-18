import { z } from 'zod';
import { getImportProblems } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The rows a person needs to fix in their own spreadsheet. */
export const GET = route(
  { permission: 'members.member.read', source: 'query', schema: query },
  async ({ input, actor, params }) =>
    getImportProblems(tenantOf(actor), actor.permissions, params.id!, input),
);
