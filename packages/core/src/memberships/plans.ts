import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { endDateFor, today, type DurationUnit } from '../shared/dates';
import { formatRupees, splitTax, toPaise, toRupees } from '../shared/money';

export interface PlanContext {
  organizationId: string;
  userId: string;
}

export interface CreatePlanInput {
  name: string;
  description?: string;
  category?:
    | 'GENERAL'
    | 'PERSONAL_TRAINING'
    | 'GROUP_TRAINING'
    | 'FAMILY'
    | 'STUDENT'
    | 'CORPORATE'
    | 'DAY_PASS'
    | 'CUSTOM';
  durationUnit: DurationUnit;
  durationValue: number;
  sessionCount?: number;
  price: string;
  /**
   * Omit it and the gym's default tax rate applies — in India that is the
   * right default, because GST applies to a gym membership and a plan that
   * quietly charges 0% is an under-collection nobody notices until filing.
   * Pass null to mean a deliberately tax-free plan.
   */
  taxRateId?: string | null;
  priceIncludesTax?: boolean;
  joiningFee?: string;
  freezeAllowed?: boolean;
  freezeMaxDays?: number;
  graceDays?: number;
  transferAllowed?: boolean;
  discountAllowed?: boolean;
  branchIds?: string[];
  includedServices?: string[];
  visibleToMembers?: boolean;
}

export async function createPlan(
  ctx: PlanContext,
  permissions: ResolvedPermissions,
  input: CreatePlanInput,
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; name: string }> {
  requirePermission(permissions, 'memberships.plan.manage');

  if (input.durationUnit === 'SESSION' && !input.sessionCount) {
    throw new AppError('VALIDATION_FAILED', 'A session package needs a number of sessions.', [
      { field: 'sessionCount', issue: 'Required for session packages' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const clash = await tx.membershipPlan.findFirst({
      where: { name: input.name.trim(), deletedAt: null },
      select: { id: true },
    });
    if (clash) {
      throw new AppError('CONFLICT', 'A plan with that name already exists.', [
        { field: 'name', issue: 'Already in use' },
      ]);
    }

    if (input.branchIds?.length) {
      const valid = await tx.branch.count({ where: { id: { in: input.branchIds } } });
      if (valid !== input.branchIds.length) {
        throw new AppError('VALIDATION_FAILED', 'One of those branches is not part of this gym.');
      }
    }

    // undefined → the gym's default rate. null → deliberately no tax.
    const resolvedTaxRateId =
      input.taxRateId === undefined
        ? ((await tx.taxRate.findFirst({
            where: { isDefault: true, isActive: true },
            select: { id: true },
          })) ?? null)?.id ?? null
        : input.taxRateId;

    const plan = await tx.membershipPlan.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        description: input.description || null,
        category: input.category ?? 'GENERAL',
        durationUnit: input.durationUnit,
        durationValue: input.durationValue,
        sessionCount: input.sessionCount ?? null,
        price: input.price,
        taxRateId: resolvedTaxRateId,
        priceIncludesTax: input.priceIncludesTax ?? true,
        joiningFee: input.joiningFee ?? '0',
        freezeAllowed: input.freezeAllowed ?? false,
        freezeMaxDays: input.freezeMaxDays ?? 0,
        graceDays: input.graceDays ?? 0,
        transferAllowed: input.transferAllowed ?? false,
        discountAllowed: input.discountAllowed ?? true,
        includedServices: input.includedServices ?? [],
        visibleToMembers: input.visibleToMembers ?? true,
        availableAtAllBranches: !input.branchIds?.length,
        ...(input.branchIds?.length
          ? {
              planBranches: {
                create: input.branchIds.map((branchId) => ({
                  organizationId: ctx.organizationId,
                  branchId,
                })),
              },
            }
          : {}),
      },
      select: { id: true, name: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'plan.created',
      entityType: 'MembershipPlan',
      entityId: plan.id,
      summary: `${plan.name} at ${formatRupees(toPaise(input.price))}`,
      after: { name: plan.name, price: input.price },
      ipAddress: meta.ipAddress,
    });

    return plan;
  });
}

export interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  durationLabel: string;
  price: string;
  priceDisplay: string;
  taxLabel: string | null;
  graceDays: number;
  freezeAllowed: boolean;
  isActive: boolean;
  activeSubscriptions: number;
  branchNames: string[];
}

export function durationLabel(unit: DurationUnit, value: number, sessions?: number | null): string {
  if (unit === 'SESSION') return `${sessions ?? value} sessions`;
  const singular = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' }[unit];
  return value === 1 ? `1 ${singular}` : `${value} ${singular}s`;
}

export async function listPlans(
  ctx: PlanContext,
  permissions: ResolvedPermissions,
  options: { includeInactive?: boolean; branchId?: string } = {},
): Promise<PlanRow[]> {
  requirePermission(permissions, 'memberships.plan.read');

  return withTenant(ctx, async (tx) => {
    const plans = await tx.membershipPlan.findMany({
      where: {
        deletedAt: null,
        ...(options.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ displayOrder: 'asc' }, { price: 'asc' }],
      take: 200,
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        durationUnit: true,
        durationValue: true,
        sessionCount: true,
        price: true,
        graceDays: true,
        freezeAllowed: true,
        isActive: true,
        priceIncludesTax: true,
        taxRate: { select: { name: true, percentage: true } },
        planBranches: { select: { branch: { select: { name: true } } } },
        _count: { select: { subscriptions: { where: { status: 'ACTIVE' } } } },
      },
    });

    return plans.map((plan: any) => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      category: plan.category,
      durationLabel: durationLabel(plan.durationUnit, plan.durationValue, plan.sessionCount),
      price: plan.price.toString(),
      priceDisplay: formatRupees(toPaise(plan.price.toString())),
      taxLabel: plan.taxRate
        ? `${plan.taxRate.name}${plan.priceIncludesTax ? ' (included)' : ' (extra)'}`
        : null,
      graceDays: plan.graceDays,
      freezeAllowed: plan.freezeAllowed,
      isActive: plan.isActive,
      activeSubscriptions: plan._count.subscriptions,
      branchNames: plan.planBranches.map((pb: any) => pb.branch.name),
    }));
  });
}

/**
 * What a membership would cost and when it would end, before anyone commits.
 *
 * Reception quotes this at the desk. It is the same calculation the sale
 * uses, called from one place, so the quoted figure and the invoiced figure
 * cannot drift apart.
 */
export interface PlanQuote {
  planName: string;
  startDate: Date;
  endDate: Date;
  graceUntil: Date;
  listPrice: string;
  discount: string;
  taxable: string;
  tax: string;
  taxComponents: Record<string, string>;
  total: string;
  totalDisplay: string;
  durationLabel: string;
}

export async function quotePlan(
  ctx: PlanContext,
  input: {
    planId: string;
    startDate?: string;
    discountCode?: string;
    overridePrice?: string;
  },
): Promise<PlanQuote> {
  return withTenant(ctx, async (tx) => {
    const plan = await tx.membershipPlan.findFirst({
      where: { id: input.planId, deletedAt: null },
      select: {
        id: true,
        name: true,
        durationUnit: true,
        durationValue: true,
        sessionCount: true,
        price: true,
        priceIncludesTax: true,
        graceDays: true,
        discountAllowed: true,
        taxRate: { select: { percentage: true, components: true } },
      },
    });
    if (!plan) throw new AppError('NOT_FOUND', 'That plan does not exist.');

    const start = input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : today();
    const end = endDateFor(start, plan.durationUnit, plan.durationValue);
    const grace = new Date(end.getTime() + plan.graceDays * 86_400_000);

    const listPaise = toPaise(input.overridePrice ?? plan.price.toString());

    let discountPaise = 0;
    if (input.discountCode && plan.discountAllowed) {
      const discount = await tx.discount.findFirst({
        where: { code: input.discountCode, isActive: true },
        select: { discountType: true, value: true, maxDiscountAmount: true },
      });
      if (discount) {
        const { discountAmount } = await import('../shared/money');
        discountPaise = discountAmount(
          listPaise,
          discount.discountType,
          discount.value.toString(),
          discount.maxDiscountAmount?.toString(),
        );
      }
    }

    const payable = listPaise - discountPaise;
    const tax = splitTax(payable, plan.taxRate, { inclusive: plan.priceIncludesTax });

    return {
      planName: plan.name,
      startDate: start,
      endDate: end,
      graceUntil: grace,
      listPrice: toRupees(listPaise),
      discount: toRupees(discountPaise),
      taxable: toRupees(tax.taxable),
      tax: toRupees(tax.tax),
      taxComponents: Object.fromEntries(
        Object.entries(tax.components).map(([key, value]) => [key, toRupees(value)]),
      ),
      total: toRupees(tax.total),
      totalDisplay: formatRupees(tax.total),
      durationLabel: durationLabel(plan.durationUnit, plan.durationValue, plan.sessionCount),
    };
  });
}
