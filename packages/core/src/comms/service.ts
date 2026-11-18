import { withTenant, getJobsClient } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, branchFilter, type ResolvedPermissions } from '../rbac/engine';
import { businessDayRange, today, startOfDay } from '../shared/dates';
import { decryptSecret } from '../shared/crypto';
import { describeSendability, renderTemplate, type CommsContext } from './templates';

/**
 * Sending messages.
 *
 * The whole design turns on one rule: **a message is only ever marked sent
 * when a provider has accepted it and given back an id.** Everything else
 * stays queued or is recorded as failed with the reason. A gym that
 * believes a member was told their membership expires, when nothing left
 * the building, makes decisions on that belief — it is worse than an
 * obvious failure.
 *
 * The deploy target has no background workers, so sending is a drain: rows
 * are queued by whatever action caused them, and a bounded batch is sent by
 * a cron call that fits inside the host's request timeout. A send that
 * times out is retried, and `idempotencyKey` is what stops that retry
 * delivering the message twice.
 */

export type MessageStatus =
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'CANCELLED'
  | 'SKIPPED';

export interface QueuedMessage {
  id: string;
  status: MessageStatus;
  toAddress: string;
  skippedReason?: string;
}

/** How many a single cron pass will attempt, to stay inside the timeout. */
export const SEND_BATCH_SIZE = 40;

// ------------------------------------------------------------ preferences ---

/**
 * Whether this recipient may be sent this kind of message.
 *
 * Checked when a message is queued *and* again when it is sent, because an
 * opt-out that arrives in between has to be honoured — that gap is exactly
 * when a campaign is sitting in a queue.
 */
export async function mayReceive(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  input: {
    subjectType: 'MEMBER' | 'LEAD' | 'USER';
    subjectId: string;
    channel: string;
    category: string;
  },
): Promise<boolean> {
  const preference = await tx.communicationPreference.findFirst({
    where: {
      subjectType: input.subjectType as never,
      subjectId: input.subjectId,
      channel: input.channel as never,
      category: input.category as never,
    },
    select: { optedIn: true },
  });

  // Silence is consent for utility messages a gym must send — an invoice, a
  // membership expiring — and not for marketing, which is opt-out in law
  // and opt-out in manners.
  if (!preference) return input.category !== 'MARKETING';
  return preference.optedIn;
}

export async function setPreference(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  input: {
    subjectType: 'MEMBER' | 'LEAD' | 'USER';
    subjectId: string;
    channel: string;
    category: string;
    optedIn: boolean;
    source?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'comms.preference.manage');

  await withTenant(ctx, async (tx) => {
    await upsertPreference(tx, ctx.organizationId, input);

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: input.optedIn ? 'comms.preference.optin' : 'comms.preference.optout',
      entityType: input.subjectType,
      entityId: input.subjectId,
      summary: `${input.optedIn ? 'Opted in to' : 'Opted out of'} ${input.category.toLowerCase()} on ${input.channel.toLowerCase()}`,
      ipAddress: meta.ipAddress,
    });
  });
}

/**
 * Records an opt-out with no permission check and no tenant context.
 *
 * Called from the provider webhook, where the person asking is the member
 * themselves by replying STOP. Refusing that because an HTTP request lacks
 * a session would be absurd, so the tenant comes from the message we
 * ourselves sent them.
 */
export async function recordInboundOptOut(input: {
  organizationId: string;
  subjectType: 'MEMBER' | 'LEAD' | 'USER';
  subjectId: string;
  channel: string;
  source: string;
}): Promise<void> {
  const db = getJobsClient();

  // An opt-out is across every category that is not strictly service: a
  // member who said STOP does not want the marketing *or* the reminders.
  for (const category of ['MARKETING', 'UTILITY'] as const) {
    await upsertPreference(db, input.organizationId, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      channel: input.channel,
      category,
      optedIn: false,
      source: input.source,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertPreference(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  organizationId: string,
  input: {
    subjectType: string;
    subjectId: string;
    channel: string;
    category: string;
    optedIn: boolean;
    source?: string;
  },
): Promise<void> {
  const existing = await tx.communicationPreference.findFirst({
    where: {
      subjectType: input.subjectType as never,
      subjectId: input.subjectId,
      channel: input.channel as never,
      category: input.category as never,
    },
    select: { id: true },
  });

  const data = {
    optedIn: input.optedIn,
    optedOutAt: input.optedIn ? null : new Date(),
    source: input.source ?? null,
  };

  if (existing) {
    await tx.communicationPreference.update({ where: { id: existing.id }, data });
    return;
  }

  await tx.communicationPreference.create({
    data: {
      organizationId,
      subjectType: input.subjectType as never,
      subjectId: input.subjectId,
      channel: input.channel as never,
      category: input.category as never,
      ...data,
    },
  });
}

// --------------------------------------------------------------- queueing ---

export interface AudienceFilter {
  /** 'all' | 'active' | 'expiring' | 'expired' | 'leads' | 'selected' */
  kind: string;
  memberIds?: string[];
  branchId?: string;
  withinDays?: number;
}

export interface Recipient {
  subjectType: 'MEMBER' | 'LEAD';
  subjectId: string;
  name: string;
  phone: string;
  values: Record<string, string>;
}

/**
 * Who a campaign would actually reach.
 *
 * Returned before anything is sent, because "this will message 412 people"
 * is the one number that stops a mistake becoming 412 mistakes.
 */
export async function resolveAudience(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  filter: AudienceFilter,
): Promise<Recipient[]> {
  requirePermission(permissions, 'comms.message.send');
  const branches = branchFilter(permissions, 'comms.message.send');

  return withTenant(ctx, async (tx) => {
    if (filter.kind === 'leads') {
      const leads = await tx.lead.findMany({
        where: {
          deletedAt: null,
          status: { notIn: ['CONVERTED', 'LOST'] },
          ...(filter.branchId ? { branchId: filter.branchId } : {}),
          ...(branches ? { OR: [{ branchId: branches }, { branchId: null }] } : {}),
        },
        select: { id: true, fullName: true, phone: true },
        take: 5000,
      });

      return leads.map((lead: any) => ({
        subjectType: 'LEAD' as const,
        subjectId: lead.id,
        name: lead.fullName,
        phone: lead.phone,
        values: { name: lead.fullName, memberName: lead.fullName },
      }));
    }

    const now = today();
    const horizon = new Date(now.getTime() + (filter.withinDays ?? 7) * 86_400_000);

    const where: any = {
      deletedAt: null,
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(branches ? { OR: [{ branchId: branches }, { branchId: null }] } : {}),
    };

    if (filter.kind === 'selected') {
      where.id = { in: filter.memberIds ?? [] };
    } else if (filter.kind === 'active') {
      where.subscriptions = { some: { status: 'ACTIVE', endDate: { gte: now } } };
    } else if (filter.kind === 'expiring') {
      where.subscriptions = {
        some: { status: 'ACTIVE', endDate: { gte: now, lte: horizon } },
      };
    } else if (filter.kind === 'expired') {
      where.subscriptions = { every: { endDate: { lt: now } } };
    }

    const members = await tx.member.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        memberCode: true,
        subscriptions: {
          orderBy: { endDate: 'desc' },
          take: 1,
          select: { endDate: true, plan: { select: { name: true } } },
        },
      },
      take: 5000,
    });

    return members.map((member: any) => {
      const name = `${member.firstName} ${member.lastName ?? ''}`.trim();
      const subscription = member.subscriptions[0];
      return {
        subjectType: 'MEMBER' as const,
        subjectId: member.id,
        name,
        phone: member.phone,
        values: {
          name,
          memberName: name,
          firstName: member.firstName,
          memberCode: member.memberCode,
          planName: subscription?.plan?.name ?? '',
          expiryDate: subscription?.endDate
            ? subscription.endDate.toISOString().slice(0, 10)
            : '',
        },
      };
    });
  });
}

export interface QueueResult {
  jobId: string;
  queued: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  /** Null when WhatsApp is not connected: nothing will leave until it is. */
  blockedReason: string | null;
}

/**
 * Queues a campaign.
 *
 * Nothing is sent here. Rows are written, the opt-outs are applied, and the
 * credit limit is checked — then a cron pass does the sending. A gym that
 * presses Send and waits while four hundred HTTP calls happen in a request
 * is a gym staring at a timeout.
 */
export async function queueCampaign(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  input: {
    name: string;
    templateId: string;
    audience: AudienceFilter;
    scheduledAt?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<QueueResult> {
  requirePermission(permissions, 'comms.campaign.create');

  const recipients = await resolveAudience(ctx, permissions, input.audience);

  return withTenant(ctx, async (tx) => {
    const template = await tx.notificationTemplate.findFirst({
      where: { id: input.templateId },
      select: {
        id: true,
        name: true,
        body: true,
        channel: true,
        category: true,
        language: true,
        isActive: true,
        approvalStatus: true,
        providerTemplateName: true,
      },
    });
    if (!template) throw new AppError('NOT_FOUND', 'That template was not found.');

    const { sendable, blockedReason } = describeSendability(template);
    if (!sendable) {
      // Refused before anything is written: queueing four hundred messages
      // that can never send is not a kindness.
      throw new AppError('CONFLICT', blockedReason ?? 'That template cannot send.');
    }

    const settings = await tx.whatsappSetting.findFirst({
      select: { isEnabled: true, phoneNumberId: true, accessTokenEncrypted: true },
    });
    const connected =
      template.channel !== 'WHATSAPP' ||
      Boolean(settings?.isEnabled && settings.phoneNumberId && settings.accessTokenEncrypted);

    const job = await tx.messageJob.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        channel: template.channel,
        category: template.category,
        templateId: template.id,
        audienceFilter: input.audience as never,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        status: input.scheduledAt ? 'SCHEDULED' : 'RUNNING',
        startedAt: input.scheduledAt ? null : new Date(),
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });

    const skippedReasons: Record<string, number> = {};
    let queued = 0;
    let skipped = 0;

    for (const recipient of recipients) {
      const allowed = await mayReceive(tx, {
        subjectType: recipient.subjectType,
        subjectId: recipient.subjectId,
        channel: template.channel,
        category: template.category,
      });

      if (!allowed) {
        skipped += 1;
        skippedReasons['opted out'] = (skippedReasons['opted out'] ?? 0) + 1;
        await tx.message.create({
          data: {
            organizationId: ctx.organizationId,
            messageJobId: job.id,
            templateId: template.id,
            channel: template.channel,
            category: template.category,
            recipientType: recipient.subjectType as never,
            recipientId: recipient.subjectId,
            toAddress: recipient.phone,
            status: 'SKIPPED',
            errorCode: 'OPTED_OUT',
            errorMessage: 'This person has opted out of these messages.',
          },
        });
        continue;
      }

      if (!recipient.phone) {
        skipped += 1;
        skippedReasons['no number'] = (skippedReasons['no number'] ?? 0) + 1;
        continue;
      }

      await tx.message.create({
        data: {
          organizationId: ctx.organizationId,
          messageJobId: job.id,
          templateId: template.id,
          channel: template.channel,
          category: template.category,
          recipientType: recipient.subjectType as never,
          recipientId: recipient.subjectId,
          toAddress: recipient.phone,
          payload: recipient.values as never,
          renderedBody: renderTemplate(template.body, recipient.values),
          status: 'QUEUED',
          // Deterministic, so a retried queue call cannot double-write and
          // a provider retry cannot double-send.
          idempotencyKey: `${job.id}:${recipient.subjectId}`,
        },
      });
      queued += 1;
    }

    await tx.messageJob.update({
      where: { id: job.id },
      data: {
        recipientCount: queued + skipped,
        skippedCount: skipped,
        // A campaign where everybody was skipped has nothing to drain, so
        // it is finished now. Left running, it would sit in the list of
        // campaigns in flight for ever and make that list useless.
        ...(queued === 0 ? { status: 'COMPLETED' as never, completedAt: new Date() } : {}),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'comms.campaign.queue',
      entityType: 'MessageJob',
      entityId: job.id,
      summary: `Queued ${queued} ${template.channel.toLowerCase()} messages — ${input.name.trim()}`,
      after: { queued, skipped },
      ipAddress: meta.ipAddress,
    });

    return {
      jobId: job.id,
      queued,
      skipped,
      skippedReasons,
      blockedReason: connected
        ? null
        : 'WhatsApp is not connected for this gym, so these are queued and nothing has been sent yet.',
    };
  });
}

// ----------------------------------------------------------- the sending ---

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  held: number;
  /** Organizations that have queued messages but no connection. */
  heldReasons: string[];
}

/**
 * Sends a bounded batch of queued messages.
 *
 * Driven by cron rather than by a worker, because the deploy target has no
 * workers. Bounded because the host kills a request at 120 seconds, and a
 * batch that does not finish is a batch whose outcome nobody recorded.
 *
 * Runs across tenants deliberately: this is platform plumbing, invoked with
 * the jobs role from `/api/cron`, never from a request carrying a session.
 */
export async function drainMessageQueue(
  options: { limit?: number; organizationId?: string } = {},
): Promise<DrainResult> {
  const db = getJobsClient();
  const { sendWhatsappTemplate, toWhatsappNumber } = await import('@gym/integrations');

  const limit = Math.min(options.limit ?? SEND_BATCH_SIZE, 200);

  const due = await db.message.findMany({
    where: {
      status: 'QUEUED',
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      messageJob: {
        OR: [
          { status: 'RUNNING' },
          { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
        ],
      },
    },
    orderBy: { queuedAt: 'asc' },
    take: limit,
    select: {
      id: true,
      organizationId: true,
      toAddress: true,
      payload: true,
      channel: true,
      category: true,
      recipientType: true,
      recipientId: true,
      attempts: true,
      messageJobId: true,
      template: {
        select: {
          providerTemplateName: true,
          language: true,
          variables: true,
          approvalStatus: true,
          isActive: true,
          channel: true,
        },
      },
    },
  });

  const result: DrainResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    held: 0,
    heldReasons: [],
  };

  // One credential read per gym rather than per message.
  const credentials = new Map<
    string,
    { phoneNumberId: string; accessToken: string } | null
  >();

  for (const message of due) {
    result.attempted += 1;

    // One bad row must not abandon the rest of the batch. This runs
    // unattended on a schedule: a throw here would leave the remaining
    // messages unsent with nobody watching, and the next pass would pick
    // the same bad row first and do it again.
    try {

      // The opt-out check again: a STOP that arrived while this sat in the
      // queue has to be honoured, and that gap is exactly when it arrives.
      const allowed = await mayReceive(db, {
        subjectType: message.recipientType as 'MEMBER' | 'LEAD' | 'USER',
        subjectId: message.recipientId ?? '',
        channel: message.channel,
        category: message.category,
      });

      if (!allowed) {
        await db.message.update({
          where: { id: message.id },
          data: {
            status: 'SKIPPED',
            errorCode: 'OPTED_OUT',
            errorMessage: 'Opted out before this was sent.',
          },
        });
        result.skipped += 1;
        continue;
      }

      if (!credentials.has(message.organizationId)) {
        const settings = await db.whatsappSetting.findFirst({
          where: { organizationId: message.organizationId },
          select: { isEnabled: true, phoneNumberId: true, accessTokenEncrypted: true },
        });

        let resolved: { phoneNumberId: string; accessToken: string } | null = null;
        if (settings?.isEnabled && settings.phoneNumberId && settings.accessTokenEncrypted) {
          try {
            resolved = {
              phoneNumberId: settings.phoneNumberId,
              accessToken: decryptSecret(settings.accessTokenEncrypted),
            };
          } catch {
            // A credential that will not decrypt is a configuration problem,
            // not a message problem: held rather than failed, so it sends
            // once the key is right instead of being lost.
            resolved = null;
          }
        }
        credentials.set(message.organizationId, resolved);
      }

      const credential = credentials.get(message.organizationId) ?? null;

      if (!credential) {
        // Left QUEUED on purpose. Marking it failed would bury it; marking it
        // sent would be a lie. It goes the moment WhatsApp is connected.
        result.held += 1;
        if (!result.heldReasons.includes(message.organizationId)) {
          result.heldReasons.push(message.organizationId);
        }
        continue;
      }

      const template = message.template;
      if (!template?.providerTemplateName || template.approvalStatus !== 'APPROVED') {
        await db.message.update({
          where: { id: message.id },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            errorCode: 'TEMPLATE_NOT_APPROVED',
            errorMessage: 'WhatsApp has not approved this template.',
          },
        });
        result.failed += 1;
        continue;
      }

      await db.message.update({
        where: { id: message.id },
        data: { status: 'SENDING', attempts: { increment: 1 } },
      });

      const values = (message.payload ?? {}) as Record<string, string>;
      const outcome = await sendWhatsappTemplate(credential, {
        to: toWhatsappNumber(message.toAddress),
        templateName: template.providerTemplateName,
        language: template.language,
        variables: template.variables.map((name: string) => values[name] ?? ''),
      });

      if (outcome.ok) {
        await db.message.update({
          where: { id: message.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            providerMessageId: outcome.providerMessageId,
            errorCode: null,
            errorMessage: null,
          },
        });
        result.sent += 1;
        continue;
      }

      // Three attempts, then it stops: a queue that retries forever is a
      // queue nobody can read.
      const giveUp = !outcome.retryable || message.attempts + 1 >= 3;

      await db.message.update({
        where: { id: message.id },
        data: {
          status: giveUp ? 'FAILED' : 'QUEUED',
          ...(giveUp ? { failedAt: new Date() } : {}),
          errorCode: outcome.code,
          errorMessage: outcome.message,
        },
      });

        if (giveUp) result.failed += 1;
    } catch (error) {
      result.failed += 1;
      await db.message
        .update({
          where: { id: message.id },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            errorCode: 'SEND_ERROR',
            errorMessage: (error as Error).message.slice(0, 300),
          },
        })
        .catch(() => undefined);
    }
  }

  // Jobs whose messages have all been dealt with are closed, so the list of
  // running campaigns is the list of campaigns actually running.
  const jobIds = [...new Set(due.map((m: any) => m.messageJobId).filter(Boolean))];
  for (const jobId of jobIds) {
    const counts = await db.message.groupBy({
      by: ['status'],
      where: { messageJobId: jobId as string },
      _count: { _all: true },
    });

    const by = Object.fromEntries(
      counts.map((row: any) => [row.status, row._count._all as number]),
    );
    const outstanding = (by.QUEUED ?? 0) + (by.SENDING ?? 0);

    await db.messageJob.update({
      where: { id: jobId as string },
      data: {
        sentCount: (by.SENT ?? 0) + (by.DELIVERED ?? 0) + (by.READ ?? 0),
        deliveredCount: (by.DELIVERED ?? 0) + (by.READ ?? 0),
        failedCount: by.FAILED ?? 0,
        skippedCount: by.SKIPPED ?? 0,
        ...(outstanding === 0
          ? { status: 'COMPLETED' as never, completedAt: new Date() }
          : {}),
      },
    });
  }

  return result;
}

// ------------------------------------------------------------- the record ---

export interface MessageRow {
  id: string;
  toAddress: string;
  recipientName: string | null;
  channel: string;
  category: string;
  status: MessageStatus;
  body: string | null;
  errorMessage: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export async function listMessages(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  options: { jobId?: string; status?: MessageStatus; limit?: number } = {},
): Promise<MessageRow[]> {
  requirePermission(permissions, 'comms.history.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.message.findMany({
      where: {
        ...(options.jobId ? { messageJobId: options.jobId } : {}),
        ...(options.status ? { status: options.status } : {}),
      },
      orderBy: { queuedAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
      select: {
        id: true,
        toAddress: true,
        channel: true,
        category: true,
        status: true,
        renderedBody: true,
        errorMessage: true,
        queuedAt: true,
        sentAt: true,
        deliveredAt: true,
        recipientType: true,
        recipientId: true,
      },
    });

    const memberIds = rows
      .filter((r: any) => r.recipientType === 'MEMBER' && r.recipientId)
      .map((r: any) => r.recipientId as string);

    const members = memberIds.length
      ? await tx.member.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const names = new Map(
      members.map((m: any) => [m.id, `${m.firstName} ${m.lastName ?? ''}`.trim()]),
    );

    return rows.map((row: any) => ({
      id: row.id,
      toAddress: row.toAddress,
      recipientName: row.recipientId ? (names.get(row.recipientId) ?? null) : null,
      channel: row.channel,
      category: row.category,
      status: row.status as MessageStatus,
      body: row.renderedBody,
      errorMessage: row.errorMessage,
      queuedAt: row.queuedAt.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    }));
  });
}

export interface CampaignRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  queuedCount: number;
  scheduledAt: string | null;
  createdAt: string;
}

export async function listCampaigns(
  ctx: CommsContext,
  permissions: ResolvedPermissions,
  options: { limit?: number } = {},
): Promise<CampaignRow[]> {
  requirePermission(permissions, 'comms.history.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.messageJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 25, 100),
      select: {
        id: true,
        name: true,
        channel: true,
        status: true,
        recipientCount: true,
        sentCount: true,
        failedCount: true,
        skippedCount: true,
        scheduledAt: true,
        createdAt: true,
        _count: { select: { messages: { where: { status: 'QUEUED' } } } },
      },
    });

    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      channel: row.channel,
      status: row.status,
      recipientCount: row.recipientCount,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      skippedCount: row.skippedCount,
      queuedCount: row._count.messages,
      scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

// ------------------------------------------------------------- receipts ---

export interface WebhookOutcome {
  statusUpdates: number;
  optOuts: number;
  unknownTenant: boolean;
}

/**
 * Applies what WhatsApp tells us after the fact.
 *
 * Two things arrive here. Delivery and read receipts, which turn a SENT
 * into DELIVERED — the difference between "we sent it" and "it arrived" is
 * the difference between blaming the member and blaming the number.
 *
 * And inbound messages, which in practice are mostly STOP. An opt-out
 * arriving this way is honoured immediately and for every later send,
 * because a person who asked to be left alone has asked once.
 */
export async function applyWhatsappWebhook(payload: any): Promise<WebhookOutcome> {
  const db = getJobsClient();
  const outcome: WebhookOutcome = { statusUpdates: 0, optOuts: 0, unknownTenant: false };

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;

      // The tenant comes from the number Meta delivered to, resolved
      // against our own records — never from anything in the body a sender
      // could choose.
      const phoneNumberId = value?.metadata?.phone_number_id;
      const settings = phoneNumberId
        ? await db.whatsappSetting.findFirst({
            where: { phoneNumberId: String(phoneNumberId) },
            select: { organizationId: true },
          })
        : null;

      if (!settings) {
        outcome.unknownTenant = true;
        continue;
      }

      for (const status of value.statuses ?? []) {
        const id = status?.id;
        if (!id) continue;

        const message = await db.message.findFirst({
          where: { providerMessageId: String(id), organizationId: settings.organizationId },
          select: { id: true, status: true },
        });
        if (!message) continue;

        const at = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();

        if (status.status === 'delivered') {
          await db.message.update({
            where: { id: message.id },
            data: { status: 'DELIVERED', deliveredAt: at },
          });
          outcome.statusUpdates += 1;
        } else if (status.status === 'read') {
          await db.message.update({
            where: { id: message.id },
            data: { status: 'READ', readAt: at, deliveredAt: at },
          });
          outcome.statusUpdates += 1;
        } else if (status.status === 'failed') {
          await db.message.update({
            where: { id: message.id },
            data: {
              status: 'FAILED',
              failedAt: at,
              errorCode: String(status.errors?.[0]?.code ?? 'PROVIDER_FAILED'),
              errorMessage: String(
                status.errors?.[0]?.title ?? 'WhatsApp could not deliver this message.',
              ),
            },
          });
          outcome.statusUpdates += 1;
        }
      }

      for (const inbound of value.messages ?? []) {
        const text = String(inbound?.text?.body ?? '').trim().toUpperCase();
        if (!/^(STOP|UNSUBSCRIBE|OPT ?OUT)$/.test(text)) continue;

        const from = String(inbound?.from ?? '');
        if (!from) continue;

        // Match on the last ten digits: we store a local number, Meta sends
        // an international one.
        const local = from.slice(-10);
        const member = await db.member.findFirst({
          where: { organizationId: settings.organizationId, phone: { endsWith: local } },
          select: { id: true },
        });

        if (member) {
          await recordInboundOptOut({
            organizationId: settings.organizationId,
            subjectType: 'MEMBER',
            subjectId: member.id,
            channel: 'WHATSAPP',
            source: `Replied ${text} on WhatsApp`,
          });
          outcome.optOuts += 1;
          continue;
        }

        const lead = await db.lead.findFirst({
          where: { organizationId: settings.organizationId, phone: { endsWith: local } },
          select: { id: true },
        });
        if (lead) {
          await recordInboundOptOut({
            organizationId: settings.organizationId,
            subjectType: 'LEAD',
            subjectId: lead.id,
            channel: 'WHATSAPP',
            source: `Replied ${text} on WhatsApp`,
          });
          outcome.optOuts += 1;
        }
      }
    }
  }

  return outcome;
}

// ----------------------------------------------------------- automations ---

export interface ReminderRun {
  organizations: number;
  queued: number;
  skipped: number;
  /** Gyms with no approved expiry template, which is why nothing went. */
  withoutTemplate: number;
}

/**
 * The expiry reminders, which are the reason a gym buys any of this.
 *
 * Run from cron, once a day. A membership that lapses unnoticed is revenue
 * a gym never sees again, and the reminder nobody sent is the commonest
 * reason it lapses.
 *
 * Idempotent by construction: the key is the member, the subscription and
 * the day, so running the cron twice cannot message anybody twice.
 */
export async function queueExpiryReminders(
  options: { daysAhead?: number; organizationId?: string } = {},
): Promise<ReminderRun> {
  const db = getJobsClient();
  const daysAhead = options.daysAhead ?? 7;

  const run: ReminderRun = { organizations: 0, queued: 0, skipped: 0, withoutTemplate: 0 };

  const organizations = await db.organization.findMany({
    where: {
      status: { in: ['ACTIVE', 'TRIAL'] },
      deletedAt: null,
      ...(options.organizationId ? { id: options.organizationId } : {}),
    },
    select: { id: true },
  });

  for (const organization of organizations) {
    const template = await db.notificationTemplate.findFirst({
      where: {
        organizationId: organization.id,
        channel: 'WHATSAPP',
        isActive: true,
        approvalStatus: 'APPROVED',
        providerTemplateName: { not: null },
        key: { contains: 'expir' },
      },
      select: { id: true, body: true, category: true, channel: true },
    });

    if (!template) {
      run.withoutTemplate += 1;
      continue;
    }

    const settings = await db.orgSetting.findFirst({
      where: { organizationId: organization.id },
      select: { timezone: true },
    });
    const day = businessDayRange(settings?.timezone ?? 'Asia/Kolkata');
    const target = new Date(day.date.getTime() + daysAhead * 86_400_000);
    const targetIso = target.toISOString().slice(0, 10);

    const expiring = await db.subscription.findMany({
      where: {
        organizationId: organization.id,
        status: 'ACTIVE',
        deletedAt: null,
        endDate: target,
      },
      select: {
        id: true,
        endDate: true,
        member: {
          select: { id: true, firstName: true, lastName: true, phone: true, memberCode: true },
        },
        plan: { select: { name: true } },
      },
    });

    if (expiring.length === 0) continue;
    run.organizations += 1;

    const job = await db.messageJob.create({
      data: {
        organizationId: organization.id,
        name: `Expiry reminders — ${targetIso}`,
        channel: template.channel,
        category: template.category,
        templateId: template.id,
        status: 'RUNNING',
        startedAt: new Date(),
      },
      select: { id: true },
    });

    let queued = 0;
    let skipped = 0;

    for (const subscription of expiring) {
      const allowed = await mayReceive(db, {
        subjectType: 'MEMBER',
        subjectId: subscription.member.id,
        channel: template.channel,
        category: template.category,
      });

      if (!allowed || !subscription.member.phone) {
        skipped += 1;
        continue;
      }

      const name = `${subscription.member.firstName} ${subscription.member.lastName ?? ''}`.trim();
      const values = {
        name,
        memberName: name,
        firstName: subscription.member.firstName,
        memberCode: subscription.member.memberCode,
        planName: subscription.plan.name,
        expiryDate: subscription.endDate.toISOString().slice(0, 10),
      };

      try {
        await db.message.create({
          data: {
            organizationId: organization.id,
            messageJobId: job.id,
            templateId: template.id,
            channel: template.channel,
            category: template.category,
            recipientType: 'MEMBER',
            recipientId: subscription.member.id,
            toAddress: subscription.member.phone,
            payload: values as never,
            renderedBody: renderTemplate(template.body, values),
            status: 'QUEUED',
            // The member, the subscription and the day: running the cron
            // twice cannot message anybody twice.
            idempotencyKey: `expiry:${subscription.id}:${targetIso}`,
          },
        });
        queued += 1;
      } catch {
        // The unique key rejected it, which means it was already queued
        // today. That is the guard working, not an error.
        skipped += 1;
      }
    }

    await db.messageJob.update({
      where: { id: job.id },
      data: {
        recipientCount: queued + skipped,
        skippedCount: skipped,
        ...(queued === 0 ? { status: 'COMPLETED' as never, completedAt: new Date() } : {}),
      },
    });

    run.queued += queued;
    run.skipped += skipped;
  }

  return run;
}
