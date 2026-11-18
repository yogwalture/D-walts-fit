import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  scopeOf,
  branchFilter,
  type ResolvedPermissions,
} from '../rbac/engine';
import { businessDay, startOfDay, today } from '../shared/dates';

/**
 * Leads — the people who have not joined yet.
 *
 * A gym's growth is almost entirely this: someone walks in, asks the price,
 * says they will think about it, and is never called again. The dashboard
 * has counted open enquiries since Phase 1 and nothing could create one.
 *
 * The design is built around the one thing that actually matters, which is
 * the follow-up: every lead carries a next-follow-up date, the overdue ones
 * surface first, and logging a call sets the next date in the same action —
 * because a follow-up you have to remember to schedule separately is a
 * follow-up that does not happen.
 */

export interface CrmContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type LeadStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'FOLLOW_UP'
  | 'TRIAL_BOOKED'
  | 'NEGOTIATION'
  | 'CONVERTED'
  | 'LOST';

export type LeadSource =
  | 'WALK_IN'
  | 'WEBSITE'
  | 'REFERRAL'
  | 'INSTAGRAM'
  | 'FACEBOOK'
  | 'WHATSAPP'
  | 'TELEPHONE'
  | 'OTHER';

/** Statuses a lead is still live in. */
const OPEN_STATUSES: LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'FOLLOW_UP',
  'TRIAL_BOOKED',
  'NEGOTIATION',
];

export interface CreateLeadInput {
  fullName: string;
  phone: string;
  email?: string;
  city?: string;
  source?: LeadSource;
  sourceDetail?: string;
  interestedPlanId?: string;
  budgetNote?: string;
  branchId?: string;
  assignedToOrgUserId?: string;
  nextFollowUpAt?: string;
  notes?: string;
}

/**
 * Records an enquiry.
 *
 * A duplicate phone number is reported rather than blocked, the same way it
 * is for members: the same person enquiring twice is worth knowing about,
 * but so is a family where one number reaches three people.
 */
export async function createLead(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  input: CreateLeadInput & { allowDuplicate?: boolean },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; duplicateOf: string | null }> {
  requirePermission(permissions, 'crm.lead.create');

  return withTenant(ctx, async (tx) => {
    const existing = await tx.lead.findFirst({
      where: { phone: input.phone, deletedAt: null, status: { in: OPEN_STATUSES } },
      select: { id: true, fullName: true, status: true },
    });

    if (existing && !input.allowDuplicate) {
      throw new AppError(
        'DUPLICATE_LEAD',
        `${existing.fullName} is already an open enquiry on that number.`,
        [{ field: 'phone', issue: `Already an enquiry — ${existing.fullName}` }],
      );
    }

    // Already a member? Worth saying so before anyone spends a call on it.
    const member = await tx.member.findFirst({
      where: { phone: input.phone, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, memberCode: true },
    });
    if (member && !input.allowDuplicate) {
      throw new AppError(
        'DUPLICATE_LEAD',
        `That number already belongs to ${[member.firstName, member.lastName]
          .filter(Boolean)
          .join(' ')} (${member.memberCode}).`,
        [{ field: 'phone', issue: 'Already a member' }],
      );
    }

    const branchId =
      input.branchId ??
      (
        await tx.branch.findFirst({
          where: { isActive: true, deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { id: true },
        })
      )?.id ??
      null;

    const lead = await tx.lead.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        fullName: input.fullName.trim().slice(0, 160),
        phone: input.phone,
        email: input.email?.trim().toLowerCase() || null,
        city: input.city?.trim() || null,
        source: (input.source ?? 'WALK_IN') as never,
        sourceDetail: input.sourceDetail?.trim().slice(0, 200) || null,
        interestedPlanId: input.interestedPlanId ?? null,
        budgetNote: input.budgetNote?.trim().slice(0, 300) || null,
        assignedToOrgUserId: input.assignedToOrgUserId ?? null,
        // Default to tomorrow rather than nothing: an enquiry with no next
        // date is the one that gets forgotten.
        nextFollowUpAt: input.nextFollowUpAt
          ? new Date(`${input.nextFollowUpAt}T09:00:00Z`)
          : new Date(Date.now() + 86_400_000),
        notes: input.notes?.trim().slice(0, 2000) || null,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'crm.lead.created',
      entityType: 'Lead',
      entityId: lead.id,
      summary: `Enquiry from ${input.fullName.trim()}`,
      ipAddress: meta.ipAddress,
    });

    return { id: lead.id, duplicateOf: existing?.id ?? null };
  });
}

export interface LeadRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  status: string;
  source: string;
  interestedPlanName: string | null;
  assignedToName: string | null;
  nextFollowUpAt: Date | null;
  /** Negative when the follow-up is overdue. */
  daysUntilFollowUp: number | null;
  createdAt: Date;
  lastActivityAt: Date | null;
}

export async function listLeads(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  options: {
    page?: number;
    pageSize?: number;
    status?: string;
    /** `overdue` and `today` are the two views a gym actually works from. */
    filter?: 'all' | 'open' | 'overdue' | 'today' | 'unassigned' | 'converted' | 'lost';
    assignedToOrgUserId?: string;
    search?: string;
    branchId?: string;
  } = {},
): Promise<{ rows: LeadRow[]; total: number }> {
  requirePermission(permissions, 'crm.lead.read');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 25, 100);
  const now = new Date();
  const endOfToday = new Date(businessDay().getTime() + 86_400_000);

  // A staff member with OWN scope on leads sees the ones assigned to them.
  const scope = scopeOf(permissions, 'crm.lead.read');

  return withTenant(ctx, async (tx) => {
    let ownFilter: Record<string, unknown> = {};
    if (scope === 'OWN') {
      const me = await tx.orgUser.findFirst({
        where: { userId: ctx.userId, deletedAt: null },
        select: { id: true },
      });
      ownFilter = { assignedToOrgUserId: me?.id ?? '00000000-0000-0000-0000-000000000000' };
    } else if (scope === 'BRANCH') {
      ownFilter = { branchId: branchFilter(permissions, 'crm.lead.read') };
    }

    const filterWhere: Record<string, unknown> =
      options.filter === 'open'
        ? { status: { in: OPEN_STATUSES } }
        : options.filter === 'overdue'
          ? { status: { in: OPEN_STATUSES }, nextFollowUpAt: { lt: now } }
          : options.filter === 'today'
            ? {
                status: { in: OPEN_STATUSES },
                nextFollowUpAt: { gte: businessDay(), lt: endOfToday },
              }
            : options.filter === 'unassigned'
              ? { status: { in: OPEN_STATUSES }, assignedToOrgUserId: null }
              : options.filter === 'converted'
                ? { status: 'CONVERTED' }
                : options.filter === 'lost'
                  ? { status: 'LOST' }
                  : {};

    const where: Record<string, unknown> = {
      deletedAt: null,
      ...ownFilter,
      ...filterWhere,
      ...(options.status && options.status !== 'all'
        ? { status: options.status as LeadStatus }
        : {}),
      ...(options.assignedToOrgUserId
        ? { assignedToOrgUserId: options.assignedToOrgUserId }
        : {}),
      ...(options.branchId ? { branchId: options.branchId } : {}),
      ...(options.search
        ? {
            OR: [
              { fullName: { contains: options.search, mode: 'insensitive' as const } },
              { phone: { contains: options.search } },
              { email: { contains: options.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.lead.findMany({
        where,
        // Oldest follow-up first: the overdue ones are the point of the list.
        orderBy: [{ nextFollowUpAt: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          status: true,
          source: true,
          nextFollowUpAt: true,
          createdAt: true,
          interestedPlan: { select: { name: true } },
          assignedTo: { select: { user: { select: { fullName: true } } } },
          activities: {
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { occurredAt: true },
          },
        },
      }),
      tx.lead.count({ where }),
    ]);

    return {
      total,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows: rows.map((row: any) => ({
        id: row.id,
        fullName: row.fullName,
        phone: row.phone,
        email: row.email,
        status: row.status,
        source: row.source,
        interestedPlanName: row.interestedPlan?.name ?? null,
        assignedToName: row.assignedTo?.user.fullName ?? null,
        nextFollowUpAt: row.nextFollowUpAt,
        daysUntilFollowUp: row.nextFollowUpAt
          ? Math.round(
              (startOfDay(row.nextFollowUpAt).getTime() - today().getTime()) / 86_400_000,
            )
          : null,
        createdAt: row.createdAt,
        lastActivityAt: row.activities[0]?.occurredAt ?? null,
      })),
    };
  });
}

export async function getLead(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  leadId: string,
) {
  requirePermission(permissions, 'crm.lead.read');

  return withTenant(ctx, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        city: true,
        status: true,
        source: true,
        sourceDetail: true,
        budgetNote: true,
        notes: true,
        nextFollowUpAt: true,
        lostReason: true,
        lostAt: true,
        convertedAt: true,
        createdAt: true,
        interestedPlan: { select: { id: true, name: true, price: true } },
        assignedTo: { select: { id: true, user: { select: { fullName: true } } } },
        branch: { select: { name: true } },
        convertedMember: { select: { id: true, memberCode: true } },
        activities: {
          orderBy: { occurredAt: 'desc' },
          take: 50,
          select: {
            id: true,
            activityType: true,
            outcome: true,
            notes: true,
            occurredAt: true,
            actorOrgUserId: true,
          },
        },
        trialBookings: {
          orderBy: { scheduledFor: 'desc' },
          take: 10,
          select: { id: true, scheduledFor: true, attended: true, feedback: true },
        },
      },
    });

    if (!lead) throw new AppError('NOT_FOUND', 'That enquiry was not found.');
    return lead;
  });
}

/**
 * Logs a call, a message, a visit — and sets the next follow-up in the same
 * action.
 *
 * Splitting those two would be the obvious design and the wrong one: a
 * follow-up that has to be scheduled as a separate step is one that does not
 * get scheduled, and the lead goes quiet.
 */
export async function logActivity(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  input: {
    leadId: string;
    activityType: string;
    outcome?: string;
    notes?: string;
    nextFollowUpAt?: string | null;
    status?: LeadStatus;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; status: LeadStatus; nextFollowUpAt: string | null }> {
  requirePermission(permissions, 'crm.followup.manage');

  return withTenant(ctx, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: input.leadId, deletedAt: null },
      select: { id: true, fullName: true, status: true },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'That enquiry was not found.');

    if (lead.status === 'CONVERTED') {
      throw new AppError('CONFLICT', 'That enquiry has already become a member.');
    }

    const me = await tx.orgUser.findFirst({
      where: { userId: ctx.userId, deletedAt: null },
      select: { id: true },
    });

    const nextFollowUpAt =
      input.nextFollowUpAt === null
        ? null
        : input.nextFollowUpAt
          ? new Date(`${input.nextFollowUpAt}T09:00:00Z`)
          : undefined;

    await tx.leadActivity.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        activityType: input.activityType.trim().slice(0, 40),
        outcome: input.outcome?.trim().slice(0, 80) || null,
        notes: input.notes?.trim().slice(0, 2000) || null,
        nextFollowUpAt: nextFollowUpAt ?? null,
        actorOrgUserId: me?.id ?? null,
      },
    });

    // Returned, not discarded: the caller logged a call in order to move the
    // follow-up, so the new date is the answer to the request. Without it the
    // list has to be fetched again to find out what just happened.
    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...(input.status ? { status: input.status as never } : {}),
        ...(nextFollowUpAt !== undefined ? { nextFollowUpAt } : {}),
      },
      select: { id: true, status: true, nextFollowUpAt: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'crm.lead.activity',
      entityType: 'Lead',
      entityId: lead.id,
      summary: `${input.activityType} with ${lead.fullName}${
        input.outcome ? ` — ${input.outcome}` : ''
      }`,
      ipAddress: meta.ipAddress,
    });

    return {
      id: updated.id,
      status: updated.status as LeadStatus,
      nextFollowUpAt: updated.nextFollowUpAt
        ? updated.nextFollowUpAt.toISOString()
        : null,
    };
  });
}

export async function updateLead(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  leadId: string,
  input: Partial<CreateLeadInput> & { status?: LeadStatus; lostReason?: string },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'crm.lead.update');

  await withTenant(ctx, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, fullName: true, status: true },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'That enquiry was not found.');

    const clearable = (value: string | null | undefined): string | null | undefined => {
      if (value === undefined) return undefined;
      const trimmed = typeof value === 'string' ? value.trim() : value;
      return trimmed ? trimmed : null;
    };

    const data: Record<string, unknown> = {};
    const assign = (key: string, value: unknown) => {
      if (value !== undefined) data[key] = value;
    };

    assign('fullName', input.fullName?.trim());
    assign('phone', input.phone);
    assign('email', clearable(input.email));
    assign('city', clearable(input.city));
    assign('source', input.source);
    assign('sourceDetail', clearable(input.sourceDetail));
    assign('interestedPlanId', input.interestedPlanId ?? undefined);
    assign('budgetNote', clearable(input.budgetNote));
    assign('assignedToOrgUserId', input.assignedToOrgUserId ?? undefined);
    assign('notes', clearable(input.notes));
    if (input.nextFollowUpAt !== undefined) {
      data.nextFollowUpAt = input.nextFollowUpAt
        ? new Date(`${input.nextFollowUpAt}T09:00:00Z`)
        : null;
    }

    if (input.status) {
      if (input.status === 'CONVERTED') {
        // Converting is its own operation, because it creates a member.
        throw new AppError(
          'VALIDATION_FAILED',
          'Use "convert to member" rather than setting the status directly.',
        );
      }
      data.status = input.status;
      if (input.status === 'LOST') {
        if (!input.lostReason?.trim()) {
          throw new AppError('VALIDATION_FAILED', 'Record why this enquiry was lost.', [
            { field: 'lostReason', issue: 'Required' },
          ]);
        }
        data.lostReason = input.lostReason.trim().slice(0, 300);
        data.lostAt = new Date();
        // A lost lead has no next follow-up; leaving one would keep it in
        // the overdue list forever.
        data.nextFollowUpAt = null;
      }
    }

    await tx.lead.update({ where: { id: lead.id }, data });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'crm.lead.updated',
      entityType: 'Lead',
      entityId: lead.id,
      summary:
        input.status === 'LOST'
          ? `${lead.fullName} marked lost — ${input.lostReason}`
          : `Updated ${lead.fullName}`,
      ipAddress: meta.ipAddress,
    });
  });
}

// ----------------------------------------------------------- converting ---

/**
 * Turns an enquiry into a member.
 *
 * One transaction, because a half-converted lead is the worst outcome: a
 * member who exists with no record of where they came from, or a lead marked
 * converted with no member behind it. The link is kept in both directions so
 * a gym can still answer "which of our members came from Instagram" a year
 * later, which is the only way to know whether the advertising worked.
 */
export async function convertLead(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  input: {
    leadId: string;
    /** Anything not given is taken from the lead. */
    firstName?: string;
    lastName?: string;
    email?: string;
    allowDuplicate?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ memberId: string; memberCode: string }> {
  requirePermission(permissions, 'crm.lead.update');
  requirePermission(permissions, 'members.member.create');

  const { allocateMemberCode } = await import('../shared/sequences');

  return withTenant(ctx, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: input.leadId, deletedAt: null },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        city: true,
        branchId: true,
        status: true,
        source: true,
        assignedToOrgUserId: true,
      },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'That enquiry was not found.');
    if (lead.status === 'CONVERTED') {
      throw new AppError('CONFLICT', 'That enquiry has already become a member.');
    }

    const existing = await tx.member.findFirst({
      where: { phone: lead.phone, deletedAt: null },
      select: { id: true, memberCode: true, firstName: true, lastName: true },
    });
    if (existing && !input.allowDuplicate) {
      throw new AppError(
        'DUPLICATE_MEMBER',
        `${[existing.firstName, existing.lastName].filter(Boolean).join(' ')} (${
          existing.memberCode
        }) already has that number.`,
        [{ field: 'phone', issue: 'Already a member' }],
      );
    }

    // Split the enquiry's single name field, the same way the importer does.
    const parts = lead.fullName.trim().split(/\s+/).filter(Boolean);
    const firstName = input.firstName?.trim() || parts[0] || lead.fullName.trim();
    const lastName =
      input.lastName?.trim() || (parts.length > 1 ? parts.slice(1).join(' ') : undefined);

    const branchId =
      lead.branchId ??
      (
        await tx.branch.findFirst({
          where: { isActive: true, deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { id: true },
        })
      )?.id ??
      null;

    const memberCode = await allocateMemberCode(tx, ctx.organizationId);

    const member = await tx.member.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        memberCode,
        firstName: firstName.slice(0, 80),
        lastName: lastName?.slice(0, 80) ?? null,
        phone: lead.phone,
        email: input.email?.trim().toLowerCase() || lead.email,
        city: lead.city,
        joiningDate: new Date(),
        // No membership has been sold yet, so they are not active. Selling
        // one is the next step and is what makes them active.
        status: 'INACTIVE',
        convertedFromLeadId: lead.id,
        assignedTrainerOrgUserId: null,
      },
      select: { id: true, memberCode: true },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        status: 'CONVERTED',
        convertedAt: new Date(),
        nextFollowUpAt: null,
      },
    });

    await tx.leadActivity.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        activityType: 'CONVERTED',
        outcome: 'Joined',
        notes: `Became member ${member.memberCode}`,
      },
    });

    await tx.memberTimelineEntry.create({
      data: {
        organizationId: ctx.organizationId,
        memberId: member.id,
        entryType: 'NOTE',
        title: `Joined from a ${lead.source.toLowerCase().replace('_', ' ')} enquiry`,
        sourceType: 'Lead',
        sourceId: lead.id,
        actorUserId: ctx.userId,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'crm.lead.converted',
      entityType: 'Lead',
      entityId: lead.id,
      summary: `${lead.fullName} joined as ${member.memberCode}`,
      ipAddress: meta.ipAddress,
    });

    return { memberId: member.id, memberCode: member.memberCode };
  });
}

// ------------------------------------------------------------- pipeline ---

export interface PipelineSummary {
  byStatus: Array<{ status: string; count: number }>;
  bySource: Array<{ label: string; value: number }>;
  openTotal: number;
  overdueTotal: number;
  dueTodayTotal: number;
  /** Converted divided by everything that reached a conclusion. */
  conversionRate: number;
  convertedInRange: number;
  lostInRange: number;
}

export async function getPipeline(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  options: { fromDate?: string; toDate?: string } = {},
): Promise<PipelineSummary> {
  requirePermission(permissions, 'crm.pipeline.read');

  const now = new Date();
  const endOfToday = new Date(businessDay().getTime() + 86_400_000);

  const rangeWhere =
    options.fromDate || options.toDate
      ? {
          createdAt: {
            ...(options.fromDate ? { gte: new Date(`${options.fromDate}T00:00:00Z`) } : {}),
            ...(options.toDate ? { lte: new Date(`${options.toDate}T23:59:59Z`) } : {}),
          },
        }
      : {};

  return withTenant(ctx, async (tx) => {
    const [byStatus, bySource, overdueTotal, dueTodayTotal, converted, lost] = await Promise.all([
      tx.lead.groupBy({
        by: ['status'],
        where: { deletedAt: null, ...rangeWhere },
        _count: true,
      }),
      tx.lead.groupBy({
        by: ['source'],
        where: { deletedAt: null, ...rangeWhere },
        _count: true,
      }),
      tx.lead.count({
        where: { deletedAt: null, status: { in: OPEN_STATUSES }, nextFollowUpAt: { lt: now } },
      }),
      tx.lead.count({
        where: {
          deletedAt: null,
          status: { in: OPEN_STATUSES },
          nextFollowUpAt: { gte: businessDay(), lt: endOfToday },
        },
      }),
      tx.lead.count({ where: { deletedAt: null, status: 'CONVERTED', ...rangeWhere } }),
      tx.lead.count({ where: { deletedAt: null, status: 'LOST', ...rangeWhere } }),
    ]);

    const openTotal = byStatus
      .filter((row: { status: string }) => OPEN_STATUSES.includes(row.status as LeadStatus))
      .reduce((sum: number, row: { _count: number }) => sum + row._count, 0);

    const concluded = converted + lost;

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      byStatus: byStatus.map((row: any) => ({ status: row.status, count: row._count })),
      bySource: bySource
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((row: any) => ({
          label: String(row.source).toLowerCase().replace(/_/g, ' '),
          value: row._count,
        }))
        .sort((a: { value: number }, b: { value: number }) => b.value - a.value),
      openTotal,
      overdueTotal,
      dueTodayTotal,
      // Rounded to whole points: a conversion rate quoted to two decimals
      // implies a precision a gym's numbers do not have.
      conversionRate: concluded > 0 ? Math.round((converted / concluded) * 100) : 0,
      convertedInRange: converted,
      lostInRange: lost,
    };
  });
}

/** Books a trial session, which is the step that converts best. */
export async function bookTrial(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  input: {
    leadId: string;
    scheduledFor: string;
    trainerOrgUserId?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'crm.followup.manage');

  return withTenant(ctx, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { id: input.leadId, deletedAt: null },
      select: { id: true, fullName: true, status: true },
    });
    if (!lead) throw new AppError('NOT_FOUND', 'That enquiry was not found.');
    if (lead.status === 'CONVERTED') {
      throw new AppError('CONFLICT', 'That enquiry has already become a member.');
    }

    const scheduledFor = new Date(input.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      throw new AppError('VALIDATION_FAILED', 'That is not a valid date and time.');
    }

    const booking = await tx.trialBooking.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        scheduledFor,
        trainerOrgUserId: input.trainerOrgUserId ?? null,
      },
      select: { id: true },
    });

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        status: 'TRIAL_BOOKED',
        // Follow up the day after the trial, which is when the answer comes.
        nextFollowUpAt: new Date(scheduledFor.getTime() + 86_400_000),
      },
    });

    await tx.leadActivity.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        activityType: 'TRIAL_BOOKED',
        notes: `Trial on ${scheduledFor.toISOString().slice(0, 16).replace('T', ' ')}`,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'crm.trial.booked',
      entityType: 'Lead',
      entityId: lead.id,
      summary: `Trial booked for ${lead.fullName}`,
      ipAddress: meta.ipAddress,
    });

    return booking;
  });
}

/** Records whether they turned up — the number that tells a gym if trials work. */
export async function recordTrialOutcome(
  ctx: CrmContext,
  permissions: ResolvedPermissions,
  input: { bookingId: string; attended: boolean; feedback?: string },
): Promise<void> {
  requirePermission(permissions, 'crm.followup.manage');

  await withTenant(ctx, async (tx) => {
    const booking = await tx.trialBooking.findFirst({
      where: { id: input.bookingId },
      select: { id: true, leadId: true },
    });
    if (!booking) throw new AppError('NOT_FOUND', 'That trial booking was not found.');

    await tx.trialBooking.update({
      where: { id: booking.id },
      data: {
        attended: input.attended,
        feedback: input.feedback?.trim().slice(0, 1000) || null,
      },
    });

    await tx.leadActivity.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: booking.leadId,
        activityType: 'TRIAL',
        outcome: input.attended ? 'Attended' : 'Did not turn up',
        notes: input.feedback?.trim().slice(0, 1000) || null,
      },
    });
  });
}
