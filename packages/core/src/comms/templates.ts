import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';

/**
 * Message templates.
 *
 * Meta accepts a business-initiated WhatsApp message only against a
 * template it has approved, under the name *it* assigned. So a template
 * here carries two names: the gym's own, which is what staff pick from, and
 * `providerTemplateName`, which is what Meta knows. Until the second is set
 * and the status is APPROVED, this template cannot send on WhatsApp — and
 * saying so here is better than handing it to the API to fail.
 */

export interface CommsContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type Channel = 'WHATSAPP' | 'PUSH' | 'EMAIL' | 'SMS' | 'IN_APP';
export type Category = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION' | 'SERVICE';
export type ApprovalStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED';

export interface TemplateView {
  id: string;
  key: string;
  name: string;
  channel: Channel;
  category: Category;
  language: string;
  subject: string | null;
  body: string;
  variables: string[];
  providerTemplateName: string | null;
  approvalStatus: ApprovalStatus;
  approvalNote: string | null;
  isActive: boolean;
  /** Whether this template could actually send right now, and why not. */
  sendable: boolean;
  blockedReason: string | null;
}

/** `{{memberName}}` — the variables a body actually uses, in order. */
export function variablesIn(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Fills a body from a bag of values, leaving an unknown variable visible. */
export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole,
  );
}

export function describeSendability(template: {
  channel: string;
  isActive: boolean;
  approvalStatus: string;
  providerTemplateName: string | null;
}): { sendable: boolean; blockedReason: string | null } {
  if (!template.isActive) {
    return { sendable: false, blockedReason: 'This template is switched off.' };
  }
  if (template.channel !== 'WHATSAPP') {
    return { sendable: true, blockedReason: null };
  }
  if (template.approvalStatus !== 'APPROVED') {
    return {
      sendable: false,
      blockedReason:
        'WhatsApp has not approved this template yet. Business-initiated messages can only use an approved template.',
    };
  }
  if (!template.providerTemplateName) {
    return {
      sendable: false,
      blockedReason:
        'The name WhatsApp approved this template under has not been recorded, so a send would be refused.',
    };
  }
  return { sendable: true, blockedReason: null };
}

function view(row: any): TemplateView {
  const { sendable, blockedReason } = describeSendability(row);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    channel: row.channel as Channel,
    category: row.category as Category,
    language: row.language,
    subject: row.subject,
    body: row.body,
    variables: row.variables,
    providerTemplateName: row.providerTemplateName,
    approvalStatus: row.approvalStatus as ApprovalStatus,
    approvalNote: row.approvalNote,
    isActive: row.isActive,
    sendable,
    blockedReason,
  };
}

export async function listTemplates(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  options: { channel?: Channel; includeInactive?: boolean } = {},
): Promise<TemplateView[]> {
  requirePermission(permissions, 'comms.template.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.notificationTemplate.findMany({
      where: {
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ channel: 'asc' }, { name: 'asc' }],
    });

    return rows.map(view);
  });
}

export async function createTemplate(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  input: {
    key?: string;
    name: string;
    channel: Channel;
    category?: Category;
    language?: string;
    subject?: string;
    body: string;
    providerTemplateName?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; variables: string[] }> {
  requirePermission(permissions, 'comms.template.manage');

  const key =
    input.key?.trim() ||
    input.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

  if (!key) {
    throw new AppError('VALIDATION_FAILED', 'That name does not make a usable key.', [
      { field: 'name', issue: 'Use letters or numbers' },
    ]);
  }

  const language = input.language ?? 'en';
  const variables = variablesIn(input.body);

  return withTenant(ctx, async (tx) => {
    const clash = await tx.notificationTemplate.findFirst({
      where: { key, channel: input.channel, language },
      select: { id: true },
    });
    if (clash) {
      throw new AppError(
        'CONFLICT',
        `There is already a ${input.channel.toLowerCase()} template called ${input.name.trim()}.`,
      );
    }

    const created = await tx.notificationTemplate.create({
      data: {
        organizationId: ctx.organizationId,
        key,
        name: input.name.trim(),
        channel: input.channel as never,
        category: (input.category ?? 'UTILITY') as never,
        language,
        subject: input.subject?.trim() || null,
        body: input.body,
        variables,
        providerTemplateName: input.providerTemplateName?.trim() || null,
        // A new WhatsApp template is a draft until Meta says otherwise.
        // Nothing here can approve it on Meta's behalf.
        approvalStatus: 'DRAFT',
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'comms.template.create',
      entityType: 'NotificationTemplate',
      entityId: created.id,
      summary: `Added the ${input.channel.toLowerCase()} template ${input.name.trim()}`,
      ipAddress: meta.ipAddress,
    });

    return { id: created.id, variables };
  });
}

export async function updateTemplate(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  templateId: string,
  input: {
    name?: string;
    subject?: string | null;
    body?: string;
    category?: Category;
    providerTemplateName?: string | null;
    approvalStatus?: ApprovalStatus;
    approvalNote?: string | null;
    isActive?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'comms.template.manage');

  await withTenant(ctx, async (tx) => {
    const existing = await tx.notificationTemplate.findFirst({
      where: { id: templateId },
      select: { id: true, name: true, body: true, channel: true, approvalStatus: true },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'That template was not found.');

    // Editing the words of an approved WhatsApp template invalidates the
    // approval: Meta approved particular text, not a slot to put text in.
    const bodyChanged = input.body !== undefined && input.body !== existing.body;
    const losesApproval =
      bodyChanged && existing.channel === 'WHATSAPP' && existing.approvalStatus === 'APPROVED';

    await tx.notificationTemplate.update({
      where: { id: templateId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.subject !== undefined ? { subject: input.subject?.trim() || null } : {}),
        ...(input.body !== undefined ? { body: input.body, variables: variablesIn(input.body) } : {}),
        ...(input.category !== undefined ? { category: input.category as never } : {}),
        ...(input.providerTemplateName !== undefined
          ? { providerTemplateName: input.providerTemplateName?.trim() || null }
          : {}),
        ...(input.approvalStatus !== undefined
          ? {
              approvalStatus: input.approvalStatus as never,
              ...(input.approvalStatus === 'APPROVED' ? { approvedAt: new Date() } : {}),
              ...(input.approvalStatus === 'PENDING' ? { submittedAt: new Date() } : {}),
            }
          : losesApproval
            ? { approvalStatus: 'DRAFT' as never, approvedAt: null }
            : {}),
        ...(input.approvalNote !== undefined
          ? { approvalNote: input.approvalNote?.trim() || null }
          : losesApproval
            ? { approvalNote: 'The wording changed, so WhatsApp has to approve it again.' }
            : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'comms.template.update',
      entityType: 'NotificationTemplate',
      entityId: templateId,
      summary: losesApproval
        ? `Edited ${existing.name}; it needs WhatsApp approval again`
        : `Edited the template ${existing.name}`,
      ipAddress: meta.ipAddress,
    });
  });
}
