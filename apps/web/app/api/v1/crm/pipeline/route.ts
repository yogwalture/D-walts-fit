import { pipelineQuery } from '@gym/contracts';
import { getPipeline } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'crm.pipeline.read', source: 'query', schema: pipelineQuery },
  async ({ input, actor }) => getPipeline(tenantOf(actor), actor.permissions, input),
);
