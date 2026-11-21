import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { requirePermission, branchFilter, type ResolvedPermissions } from '../rbac/engine';
import { toPaise, toRupees } from '../shared/money';
import { startOfDay } from '../shared/dates';

/**
 * Reports — the numbers a gym owner is asked for by somebody else.
 *
 * The dashboard answers "how are we doing"; this answers "what do I give the
 * accountant", which is a different question with a different tolerance for
 * being approximately right. So the tax summary is built from the invoice
 * lines rather than from totals: GSTR-1 is filed by rate, and a single
 * figure for "tax collected" cannot be filed at all.
 *
 * Everything here is read-only and returns plain rows, which is also what
 * makes a CSV of it honest — the file and the screen cannot disagree.
 */

export interface ReportContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

function range(from: string, to: string): { start: Date; end: Date } {
  const start = startOfDay(from);
  const end = startOfDay(to);
  if (end < start) {
    throw new AppError('VALIDATION_FAILED', 'That date range ends before it starts.', [
      { field: 'to', issue: 'Must be on or after the start' },
    ]);
  }
  // Inclusive of the last day.
  return { start, end: new Date(end.getTime() + 86_400_000) };
}

// ------------------------------------------------------------ collections ---

/**
 * The most rows any one report will read.
 *
 * Reports aggregate in JavaScript, so an unbounded read is both a 120-second
 * request on a shared host and however much memory the rows take. A `take`
 * on its own would be worse than either: a total computed from the first
 * 20,000 of 30,000 payments is a wrong number presented as a right one, and
 * a gym would file it.
 *
 * So every report caps the read AND says whether it hit the cap. The screen
 * shows that plainly and tells the reader to narrow the dates. A report that
 * admits it is incomplete is useful; one that quietly is, is not.
 */
export const REPORT_ROW_CAP = 20_000;

export interface ReportTruncation {
  /** True when the cap was reached, so the figures below are partial. */
  truncated: boolean;
  /** What to say about it. Null when the report is complete. */
  truncationNote: string | null;
}

function truncation(rowsRead: number, what: string): ReportTruncation {
  if (rowsRead < REPORT_ROW_CAP) return { truncated: false, truncationNote: null };
  return {
    truncated: true,
    truncationNote:
      `This covers the first ${REPORT_ROW_CAP.toLocaleString('en-IN')} ${what} in the ` +
      'period and there are more, so the totals below are incomplete. ' +
      'Choose a shorter date range.',
  };
}

export interface CollectionsReport extends ReportTruncation {
  from: string;
  to: string;
  total: string;
  count: number;
  byMethod: Array<{ method: string; amount: string; count: number }>;
  byDay: Array<{ date: string; amount: string; count: number }>;
  byStaff: Array<{ name: string; amount: string; count: number }>;
}

/**
 * What came in, broken down the three ways a gym actually checks it: by
 * payment method (because the cash drawer has to agree), by day, and by who
 * took it (because that is how a shortfall is traced).
 */
export async function collectionsReport(
  ctx: ReportContext,
  permissions: ResolvedPermissions,
  options: { from: string; to: string; branchId?: string },
): Promise<CollectionsReport> {
  requirePermission(permissions, 'finance.report.read');
  const branches = branchFilter(permissions, 'finance.report.read');
  const { start, end } = range(options.from, options.to);

  return withTenant(ctx, async (tx) => {
    const payments = await tx.payment.findMany({
      where: {
        status: { in: ['CAPTURED'] },
        receivedAt: { gte: start, lt: end },
        ...(options.branchId ? { branchId: options.branchId } : {}),
        ...(branches ? { OR: [{ branchId: branches }, { branchId: null }] } : {}),
      },
      select: {
        amount: true,
        method: true,
        receivedAt: true,
        recordedByUserId: true,
      },
      // Oldest first, so a truncated report is a complete prefix of the
      // period rather than an arbitrary slice of it.
      orderBy: { receivedAt: 'asc' },
      take: REPORT_ROW_CAP,
    });

    const userIds = [...new Set(payments.map((p: any) => p.recordedByUserId).filter(Boolean))];
    const users = userIds.length
      ? await tx.user.findMany({
          where: { id: { in: userIds as string[] } },
          select: { id: true, fullName: true },
          // Bounded by the ids above, which come from the capped read.
          take: userIds.length,
        })
      : [];
    const names = new Map(users.map((u: any) => [u.id, u.fullName]));

    const byMethod = new Map<string, { paise: number; count: number }>();
    const byDay = new Map<string, { paise: number; count: number }>();
    const byStaff = new Map<string, { paise: number; count: number }>();
    let totalPaise = 0;

    for (const payment of payments) {
      const paise = toPaise(payment.amount.toString());
      totalPaise += paise;

      const method = byMethod.get(payment.method) ?? { paise: 0, count: 0 };
      byMethod.set(payment.method, { paise: method.paise + paise, count: method.count + 1 });

      const date = payment.receivedAt.toISOString().slice(0, 10);
      const day = byDay.get(date) ?? { paise: 0, count: 0 };
      byDay.set(date, { paise: day.paise + paise, count: day.count + 1 });

      const who = payment.recordedByUserId
        ? (names.get(payment.recordedByUserId) ?? 'Unknown')
        : 'Online';
      const staff = byStaff.get(who) ?? { paise: 0, count: 0 };
      byStaff.set(who, { paise: staff.paise + paise, count: staff.count + 1 });
    }

    const sorted = <T extends { amount: string }>(rows: T[]) =>
      rows.sort((a, b) => Number(b.amount) - Number(a.amount));

    return {
      ...truncation(payments.length, 'payments'),
      from: options.from,
      to: options.to,
      total: toRupees(totalPaise),
      count: payments.length,
      byMethod: sorted(
        [...byMethod].map(([method, v]) => ({
          method,
          amount: toRupees(v.paise),
          count: v.count,
        })),
      ),
      byDay: [...byDay]
        .map(([date, v]) => ({ date, amount: toRupees(v.paise), count: v.count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      byStaff: sorted(
        [...byStaff].map(([name, v]) => ({ name, amount: toRupees(v.paise), count: v.count })),
      ),
    };
  });
}

// ------------------------------------------------------------------- GST ---

export interface TaxReport extends ReportTruncation {
  from: string;
  to: string;
  taxable: string;
  tax: string;
  total: string;
  byRate: Array<{
    ratePercent: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    tax: string;
    total: string;
    invoices: number;
  }>;
  byItemType: Array<{ itemType: string; taxable: string; tax: string; total: string }>;
}

/**
 * The GST summary, built from the invoice lines.
 *
 * By rate, because a return is filed by rate and a single "tax collected"
 * figure cannot be filed at all. The CGST/SGST split comes from the rate's
 * own components rather than halving the total, since a gym on an
 * inter-state supply charges IGST and halving would be wrong.
 */
export async function taxReport(
  ctx: ReportContext,
  permissions: ResolvedPermissions,
  options: { from: string; to: string },
): Promise<TaxReport> {
  requirePermission(permissions, 'finance.report.read');
  const { start, end } = range(options.from, options.to);

  return withTenant(ctx, async (tx) => {
    const lines = await tx.invoiceLine.findMany({
      where: {
        invoice: {
          issueDate: { gte: start, lt: end },
          status: { not: 'CANCELLED' },
        },
      },
      select: {
        itemType: true,
        taxPercentage: true,
        taxAmount: true,
        lineTotal: true,
        invoiceId: true,
        taxRate: { select: { components: true } },
      },
      orderBy: { id: 'asc' },
      take: REPORT_ROW_CAP,
    });

    const byRate = new Map<
      string,
      { taxable: number; tax: number; total: number; invoices: Set<string>; components: any }
    >();
    const byItem = new Map<string, { taxable: number; tax: number; total: number }>();

    let taxablePaise = 0;
    let taxPaise = 0;
    let totalPaise = 0;

    for (const line of lines) {
      const tax = toPaise(line.taxAmount.toString());
      const total = toPaise(line.lineTotal.toString());
      const taxable = total - tax;

      taxablePaise += taxable;
      taxPaise += tax;
      totalPaise += total;

      const rate = Number(line.taxPercentage).toFixed(2);
      const bucket = byRate.get(rate) ?? {
        taxable: 0,
        tax: 0,
        total: 0,
        invoices: new Set<string>(),
        components: line.taxRate?.components ?? null,
      };
      bucket.taxable += taxable;
      bucket.tax += tax;
      bucket.total += total;
      bucket.invoices.add(line.invoiceId);
      if (!bucket.components && line.taxRate?.components) bucket.components = line.taxRate.components;
      byRate.set(rate, bucket);

      const item = byItem.get(line.itemType) ?? { taxable: 0, tax: 0, total: 0 };
      byItem.set(line.itemType, {
        taxable: item.taxable + taxable,
        tax: item.tax + tax,
        total: item.total + total,
      });
    }

    return {
      ...truncation(lines.length, 'invoice lines'),
      from: options.from,
      to: options.to,
      taxable: toRupees(taxablePaise),
      tax: toRupees(taxPaise),
      total: toRupees(totalPaise),
      byRate: [...byRate]
        .map(([ratePercent, bucket]) => {
          // The split comes from the rate's own components. Halving the tax
          // would be wrong the moment a gym makes an inter-state supply.
          const components = (bucket.components ?? {}) as Record<string, number>;
          const percent = Number(ratePercent) || 0;
          const share = (name: string): number => {
            const value = Number(components[name] ?? 0);
            if (!percent || !value) return 0;
            return Math.round((bucket.tax * value) / percent);
          };

          const cgst = share('cgst');
          const sgst = share('sgst');
          const igst = share('igst');
          const named = cgst + sgst + igst;

          return {
            ratePercent,
            taxable: toRupees(bucket.taxable),
            // With no components recorded, the whole amount is reported
            // rather than invented into halves.
            cgst: toRupees(named === 0 ? 0 : cgst),
            sgst: toRupees(named === 0 ? 0 : sgst),
            igst: toRupees(named === 0 ? bucket.tax : igst),
            tax: toRupees(bucket.tax),
            total: toRupees(bucket.total),
            invoices: bucket.invoices.size,
          };
        })
        .sort((a, b) => Number(b.ratePercent) - Number(a.ratePercent)),
      byItemType: [...byItem]
        .map(([itemType, v]) => ({
          itemType,
          taxable: toRupees(v.taxable),
          tax: toRupees(v.tax),
          total: toRupees(v.total),
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  });
}

// ------------------------------------------------------------- what is owed ---

export interface DuesRow {
  memberId: string;
  memberCode: string;
  name: string;
  phone: string;
  invoices: number;
  oldestDueDate: string;
  daysOverdue: number;
  amountDue: string;
}

/**
 * Who owes the gym money, oldest first.
 *
 * Grouped by member rather than by invoice, because the gym rings a person,
 * not a document — and somebody with four small unpaid invoices is a
 * different conversation from somebody with one.
 */
export async function outstandingDues(
  ctx: ReportContext,
  permissions: ResolvedPermissions,
  options: { branchId?: string } = {},
): Promise<{ total: string; rows: DuesRow[] } & ReportTruncation> {
  requirePermission(permissions, 'finance.report.read');
  const branches = branchFilter(permissions, 'finance.report.read');

  return withTenant(ctx, async (tx) => {
    const invoices = await tx.invoice.findMany({
      where: {
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        memberId: { not: null },
        ...(options.branchId ? { branchId: options.branchId } : {}),
        ...(branches ? { OR: [{ branchId: branches }, { branchId: null }] } : {}),
      },
      select: {
        memberId: true,
        amountDue: true,
        dueDate: true,
        issueDate: true,
        member: {
          select: { memberCode: true, firstName: true, lastName: true, phone: true },
        },
      },
      // Oldest first: if there are more unpaid invoices than the cap, the
      // ones a gym most needs to chase are the ones it gets.
      orderBy: { issueDate: 'asc' },
      take: REPORT_ROW_CAP,
    });

    const byMember = new Map<string, DuesRow & { duePaise: number }>();
    let totalPaise = 0;

    for (const invoice of invoices) {
      const due = toPaise(invoice.amountDue.toString());
      if (due <= 0) continue;
      totalPaise += due;

      const id = invoice.memberId!;
      const existing = byMember.get(id);
      // An invoice with no due date is due now rather than never: treating
      // it as undated would quietly drop it out of the chase list.
      const dueDate = (invoice.dueDate ?? invoice.issueDate).toISOString().slice(0, 10);

      if (existing) {
        existing.duePaise += due;
        existing.invoices += 1;
        if (dueDate < existing.oldestDueDate) existing.oldestDueDate = dueDate;
      } else {
        byMember.set(id, {
          memberId: id,
          memberCode: invoice.member!.memberCode,
          name: `${invoice.member!.firstName} ${invoice.member!.lastName ?? ''}`.trim(),
          phone: invoice.member!.phone,
          invoices: 1,
          oldestDueDate: dueDate,
          daysOverdue: 0,
          amountDue: '0.00',
          duePaise: due,
        });
      }
    }

    const todayMs = startOfDay(new Date()).getTime();

    const rows = [...byMember.values()]
      .map((row) => ({
        memberId: row.memberId,
        memberCode: row.memberCode,
        name: row.name,
        phone: row.phone,
        invoices: row.invoices,
        oldestDueDate: row.oldestDueDate,
        daysOverdue: Math.max(
          0,
          Math.round((todayMs - startOfDay(row.oldestDueDate).getTime()) / 86_400_000),
        ),
        amountDue: toRupees(row.duePaise),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue || Number(b.amountDue) - Number(a.amountDue));

    return {
      ...truncation(invoices.length, 'unpaid invoices'),
      total: toRupees(totalPaise),
      rows,
    };
  });
}

// ---------------------------------------------------------- memberships ---

export interface MembershipReport extends ReportTruncation {
  from: string;
  to: string;
  sold: number;
  renewals: number;
  firstTime: number;
  expired: number;
  renewalRate: number;
  revenue: string;
  byPlan: Array<{ planName: string; sold: number; revenue: string }>;
}

/**
 * What was sold, and how much of it was somebody staying rather than
 * somebody new. A gym that counts only sales cannot see churn.
 */
export async function membershipReport(
  ctx: ReportContext,
  permissions: ResolvedPermissions,
  options: { from: string; to: string; branchId?: string },
): Promise<MembershipReport> {
  requirePermission(permissions, 'finance.report.read');
  const { start, end } = range(options.from, options.to);

  return withTenant(ctx, async (tx) => {
    const subscriptions = await tx.subscription.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        ...(options.branchId ? { branchId: options.branchId } : {}),
      },
      select: {
        totalAmount: true,
        previousSubscriptionId: true,
        plan: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: REPORT_ROW_CAP,
    });

    const expired = await tx.subscription.count({
      where: { endDate: { gte: start, lt: end }, status: { in: ['EXPIRED', 'CANCELLED'] } },
    });

    const byPlan = new Map<string, { sold: number; paise: number }>();
    let revenuePaise = 0;
    let renewals = 0;

    for (const subscription of subscriptions) {
      const paise = toPaise(subscription.totalAmount.toString());
      revenuePaise += paise;
      if (subscription.previousSubscriptionId) renewals += 1;

      const plan = byPlan.get(subscription.plan.name) ?? { sold: 0, paise: 0 };
      byPlan.set(subscription.plan.name, { sold: plan.sold + 1, paise: plan.paise + paise });
    }

    const sold = subscriptions.length;

    return {
      ...truncation(subscriptions.length, 'memberships'),
      from: options.from,
      to: options.to,
      sold,
      renewals,
      firstTime: sold - renewals,
      expired,
      // Of the memberships that came up in this period, how many were
      // renewed. Zero expiries means there is nothing to measure, not 100%.
      renewalRate: expired + renewals === 0 ? 0 : Math.round((renewals / (expired + renewals)) * 100),
      revenue: toRupees(revenuePaise),
      byPlan: [...byPlan]
        .map(([planName, v]) => ({ planName, sold: v.sold, revenue: toRupees(v.paise) }))
        .sort((a, b) => Number(b.revenue) - Number(a.revenue)),
    };
  });
}

// ----------------------------------------------------------------- CSV ---

/**
 * Rows to CSV.
 *
 * Quoting everything is deliberate: a gym called "Gold's, Nagar" and an
 * amount of 1,500.00 both break a naive join, and a spreadsheet that opens
 * wrong is worse than no export. A leading =, +, - or @ is prefixed with a
 * quote, because Excel would otherwise treat the cell as a formula.
 */
export function toCsv(rows: Array<Record<string, unknown>>, headers?: string[]): string {
  if (rows.length === 0) return '';
  const keys = headers ?? Object.keys(rows[0]!);

  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };

  return [
    keys.map(cell).join(','),
    ...rows.map((row) => keys.map((key) => cell(row[key])).join(',')),
  ].join('\r\n');
}
