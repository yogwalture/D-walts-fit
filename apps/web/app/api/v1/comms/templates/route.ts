import { NextResponse } from 'next/server';
import { templateInput, updateTemplateInput } from '@gym/contracts';
import { createTemplate, listTemplates, updateTemplate } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'comms.template.read' }, async ({ request, actor }) => {
  const params = new URL(request.url).searchParams;
  const rows = await listTemplates(tenantOf(actor), actor.permissions, {
    channel: (params.get('channel') as never) ?? undefined,
    includeInactive: params.get('includeInactive') === 'true',
  });
  return NextResponse.json({ data: rows });
});

export const POST = route(
  { permission: 'comms.template.manage', schema: templateInput },
  async ({ input, actor, ipAddress }) => {
    const created = await createTemplate(
      tenantOf(actor),
      actor.permissions,
      {
        name: input.name,
        channel: input.channel,
        category: input.category,
        language: input.language,
        subject: input.subject,
        body: input.body,
        providerTemplateName: input.providerTemplateName,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: created }, { status: 201 });
  },
);

export const PATCH = route(
  { permission: 'comms.template.manage', schema: updateTemplateInput },
  async ({ input, actor, ipAddress }) => {
    await updateTemplate(
      tenantOf(actor),
      actor.permissions,
      input.templateId,
      {
        name: input.name,
        subject: input.subject,
        body: input.body,
        category: input.category,
        providerTemplateName: input.providerTemplateName,
        approvalStatus: input.approvalStatus,
        approvalNote: input.approvalNote,
        isActive: input.isActive,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: { updated: true } });
  },
);
