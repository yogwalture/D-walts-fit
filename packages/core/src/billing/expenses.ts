import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { businessDayRange, startOfDay } from '../shared/dates';
import { toPaise, toRupees } from '../shared/money';

/**
 * What the gym spends.
 *
 * The dashboard has shown an expenses figure since Phase 2 and it has always
 * read zero, because nothing could record one. Without this the "net" number
 * on the dashboard is just revenue wearing a different label, which is worse
 * than not showing it at all.
 */

export interface ExpenseContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

/**
 * What a gym in India actually spends money on.
 *
 * Seeded on first use rather than at registration, so gyms that signed up
 * before this existed get them too. A gym can rename or ignore any of them;
 * the point is that the first expense does not begin with inventing a chart
 * of accounts.
 */
const DEFAULT_CATEGORIES = [
  'Rent',
  'Salaries',
  'Electricity',
  'Equipment',
  'Maintenance & repairs',
  'Housekeeping',
  'Marketing',
  'Supplies',
  'Internet & phone',
  'Professional fees',
  'Other',
];

export async function listExpenseCategories(
  ctx: ExpenseContext,
  permissions: ResolvedPermissions,
): Promise<Array<{ id: string; name: string }>> {
  requirePermission(permissions, 'finance.expense.read');

  return withTenant(ctx, async (tx) => {
    const existing = await tx.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    if (existing.length > 0) return existing;

    // First use: give the gym something to work with.
    await tx.expenseCategory.createMany({
      data: DEFAULT_CATEGORIES.map((name) => ({
        organizationId: ctx.organizationId,
        name,
      })),
      skipDuplicates: true,
    });

    return tx.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  });
}

export interface RecordExpenseInput {
  title: string;
  amount: string;
  taxAmount?: string;
  expenseDate: string;
  categoryId?: string;
  branchId?: string;
  method?: 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'WALLET' | 'OTHER';
  referenceNumber?: string;
  description?: string;
  isRecurring?: boolean;
}

/**
 * Records a spend.
 *
 * `amount` is what the thing cost before tax and `taxAmount` is the tax on
 * it, because that is how a bill from a supplier reads and how input tax
 * credit has to be claimed — collapsing them into one number would throw
 * away the only part an accountant needs.
 */
export async function recordExpense(
  ctx: ExpenseContext,
  permissions: ResolvedPermissions,
  input: RecordExpenseInput,
  meta: { ipAddress?: string } = {},
): Promise<{ id: string; totalAmount: string }> {
  requirePermission(permissions, 'finance.expense.manage');

  const amountPaise = toPaise(input.amount);
  if (amountPaise <= 0) {
    throw new AppError('VALIDATION_FAILED', 'An expense has to be more than zero.', [
      { field: 'amount', issue: 'Enter an amount' },
    ]);
  }

  const taxPaise = input.taxAmount ? toPaise(input.taxAmount) : 0;
  if (taxPaise < 0) {
    throw new AppError('VALIDATION_FAILED', 'Tax cannot be negative.', [
      { field: 'taxAmount', issue: 'Enter a valid amount' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    if (input.categoryId) {
      const category = await tx.expenseCategory.findFirst({
        where: { id: input.categoryId },
        select: { id: true },
      });
      if (!category) throw new AppError('NOT_FOUND', 'That expense category was not found.');
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

    const expense = await tx.expense.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        categoryId: input.categoryId ?? null,
        title: input.title.trim().slice(0, 200),
        description: input.description?.trim().slice(0, 1000) || null,
        amount: toRupees(amountPaise),
        taxAmount: toRupees(taxPaise),
        totalAmount: toRupees(amountPaise + taxPaise),
        method: input.method ?? 'CASH',
        referenceNumber: input.referenceNumber?.trim().slice(0, 60) || null,
        expenseDate: startOfDay(input.expenseDate),
        isRecurring: input.isRecurring ?? false,
        recordedByUserId: ctx.userId,
      },
      select: { id: true, totalAmount: true },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'expense.recorded',
      entityType: 'Expense',
      entityId: expense.id,
      summary: `${toRupees(amountPaise + taxPaise)} — ${input.title.trim()}`,
      ipAddress: meta.ipAddress,
    });

    return { id: expense.id, totalAmount: Number(expense.totalAmount).toFixed(2) };
  });
}

export interface ExpenseRow {
  id: string;
  title: string;
  categoryName: string | null;
  amount: string;
  taxAmount: string;
  totalAmount: string;
  method: string;
  referenceNumber: string | null;
  expenseDate: Date;
  isRecurring: boolean;
}

export async function listExpenses(
  ctx: ExpenseContext,
  permissions: ResolvedPermissions,
  options: {
    page?: number;
    pageSize?: number;
    fromDate?: string;
    toDate?: string;
    categoryId?: string;
    branchId?: string;
    search?: string;
  } = {},
): Promise<{
  rows: ExpenseRow[];
  total: number;
  totals: { amount: string; tax: string; grand: string };
}> {
  requirePermission(permissions, 'finance.expense.read');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 25, 100);

  return withTenant(ctx, async (tx) => {
    const where: Record<string, unknown> = {
      deletedAt: null,
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
      ...(options.branchId ? { branchId: options.branchId } : {}),
      ...(options.fromDate || options.toDate
        ? {
            expenseDate: {
              ...(options.fromDate ? { gte: new Date(`${options.fromDate}T00:00:00Z`) } : {}),
              ...(options.toDate ? { lte: new Date(`${options.toDate}T00:00:00Z`) } : {}),
            },
          }
        : {}),
      ...(options.search
        ? {
            OR: [
              { title: { contains: options.search, mode: 'insensitive' } },
              { description: { contains: options.search, mode: 'insensitive' } },
              { referenceNumber: { contains: options.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      tx.expense.findMany({
        where,
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          amount: true,
          taxAmount: true,
          totalAmount: true,
          method: true,
          referenceNumber: true,
          expenseDate: true,
          isRecurring: true,
          category: { select: { name: true } },
        },
      }),
      tx.expense.count({ where }),
      tx.expense.aggregate({
        where,
        _sum: { amount: true, taxAmount: true, totalAmount: true },
      }),
    ]);

    const money = (value: unknown): string => Number(value ?? 0).toFixed(2);

    return {
      total,
      totals: {
        amount: money(sums._sum?.amount),
        tax: money(sums._sum?.taxAmount),
        grand: money(sums._sum?.totalAmount),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows: rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        categoryName: row.category?.name ?? null,
        amount: money(row.amount),
        taxAmount: money(row.taxAmount),
        totalAmount: money(row.totalAmount),
        method: row.method,
        referenceNumber: row.referenceNumber,
        expenseDate: row.expenseDate,
        isRecurring: row.isRecurring,
      })),
    };
  });
}

/** Where the money went, for the month the owner is asking about. */
export async function expensesByCategory(
  ctx: ExpenseContext,
  permissions: ResolvedPermissions,
  options: { fromDate?: string; toDate?: string; branchId?: string } = {},
): Promise<Array<{ label: string; value: number }>> {
  requirePermission(permissions, 'finance.expense.read');

  return withTenant(ctx, async (tx) => {
    const grouped = await tx.expense.groupBy({
      by: ['categoryId'],
      where: {
        deletedAt: null,
        ...(options.branchId ? { branchId: options.branchId } : {}),
        ...(options.fromDate || options.toDate
          ? {
              expenseDate: {
                ...(options.fromDate ? { gte: new Date(`${options.fromDate}T00:00:00Z`) } : {}),
                ...(options.toDate ? { lte: new Date(`${options.toDate}T00:00:00Z`) } : {}),
              },
            }
          : {}),
      },
      _sum: { totalAmount: true },
    });

    const ids = grouped
      .map((row: { categoryId: string | null }) => row.categoryId)
      .filter(Boolean) as string[];

    const categories =
      ids.length > 0
        ? await tx.expenseCategory.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        : [];
    const nameById = new Map(categories.map((c) => [c.id, c.name]));

    return grouped
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((row: any) => ({
        label: row.categoryId ? (nameById.get(row.categoryId) ?? 'Uncategorised') : 'Uncategorised',
        value: Number(row._sum?.totalAmount ?? 0),
      }))
      .filter((row: { value: number }) => row.value > 0)
      .sort((a: { value: number }, b: { value: number }) => b.value - a.value);
  });
}

/** Soft delete, so a corrected mistake does not vanish from the audit trail. */
export async function deleteExpense(
  ctx: ExpenseContext,
  permissions: ResolvedPermissions,
  expenseId: string,
  meta: { reason?: string; ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'finance.expense.manage');

  await withTenant(ctx, async (tx) => {
    const expense = await tx.expense.findFirst({
      where: { id: expenseId, deletedAt: null },
      select: { id: true, title: true, totalAmount: true },
    });
    if (!expense) throw new AppError('NOT_FOUND', 'That expense was not found.');

    await tx.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'expense.deleted',
      entityType: 'Expense',
      entityId: expenseId,
      summary: `Removed ${Number(expense.totalAmount).toFixed(2)} — ${expense.title}${
        meta.reason ? ` (${meta.reason})` : ''
      }`,
      ipAddress: meta.ipAddress,
    });
  });
}

/** Today's spend, for the same end-of-shift view as the till. */
export async function todaysExpenses(
  ctx: ExpenseContext,
  permissions: ResolvedPermissions,
  options: { date?: string; branchId?: string } = {},
): Promise<{ date: string; total: string; count: number }> {
  requirePermission(permissions, 'finance.expense.read');

  return withTenant(ctx, async (tx) => {
    const branch = options.branchId
      ? await tx.branch.findFirst({
          where: { id: options.branchId },
          select: { timezone: true },
        })
      : null;
    const settings = branch ? null : await tx.orgSetting.findFirst({ select: { timezone: true } });
    const timezone = branch?.timezone ?? settings?.timezone ?? 'Asia/Kolkata';

    // The gym's day, like every other "today" in the product.
    const window = options.date
      ? businessDayRange(timezone, new Date(`${options.date}T12:00:00Z`))
      : businessDayRange(timezone);

    const result = await tx.expense.aggregate({
      where: {
        deletedAt: null,
        expenseDate: window.date,
        ...(options.branchId ? { branchId: options.branchId } : {}),
      },
      _sum: { totalAmount: true },
      _count: true,
    });

    return {
      date: window.date.toISOString().slice(0, 10),
      total: Number(result._sum?.totalAmount ?? 0).toFixed(2),
      count: result._count ?? 0,
    };
  });
}
