import { withTenant } from '@gym/db';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { addDays, businessDay, businessDayRange, startOfDay } from '../shared/dates';
import { toPaise, toRupees } from '../shared/money';

/**
 * The dashboard.
 *
 * Every figure is counted from this gym's own rows. Nothing is fabricated,
 * and an empty gym shows zeros rather than invented demo numbers — a gym
 * owner who sees plausible figures on day one stops believing the ones on
 * day thirty.
 *
 * Aggregation happens in SQL. Pulling a year of attendance into memory to
 * count it would be slow anywhere and fatal under a 120-second request
 * ceiling on shared hosting.
 */

export interface DashboardContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type DateRangeKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'thisFinancialYear'
  | 'custom';

export interface DateRange {
  /** Business days, for the date-only columns: attendance, expenses, joining. */
  from: Date;
  to: Date;
  /**
   * The real UTC instants those days cover, for the timestamp columns.
   *
   * Not interchangeable with the dates above. A payment taken at 01:00 IST
   * happens at 19:30 UTC *the previous day*, so comparing a timestamp
   * against a UTC-midnight date drops it out of the gym's own day — which
   * showed a gym open after midnight a collection figure of zero.
   */
  fromInstant: Date;
  toInstant: Date;
  label: string;
}

export function resolveRange(
  key: DateRangeKey,
  custom?: { from?: string; to?: string },
  timezone = 'Asia/Kolkata',
): DateRange {
  const withInstants = (range: { from: Date; to: Date; label: string }): DateRange => ({
    ...range,
    fromInstant: businessDayRange(timezone, noonOn(range.from)).start,
    toInstant: businessDayRange(timezone, noonOn(range.to)).end,
  });

  const todayLocal = businessDay(timezone);
  const monthStart = new Date(
    Date.UTC(todayLocal.getUTCFullYear(), todayLocal.getUTCMonth(), 1),
  );

  switch (key) {
    case 'today':
      return withInstants({ from: todayLocal, to: todayLocal, label: 'Today' });
    case 'yesterday': {
      const day = addDays(todayLocal, -1);
      return withInstants({ from: day, to: day, label: 'Yesterday' });
    }
    case 'last7':
      return withInstants({ from: addDays(todayLocal, -6), to: todayLocal, label: 'Last 7 days' });
    case 'last30':
      return withInstants({
        from: addDays(todayLocal, -29),
        to: todayLocal,
        label: 'Last 30 days',
      });
    case 'thisMonth':
      return withInstants({ from: monthStart, to: todayLocal, label: 'This month' });
    case 'lastMonth': {
      const from = new Date(
        Date.UTC(todayLocal.getUTCFullYear(), todayLocal.getUTCMonth() - 1, 1),
      );
      return withInstants({ from, to: addDays(monthStart, -1), label: 'Last month' });
    }
    case 'thisFinancialYear': {
      const year =
        todayLocal.getUTCMonth() + 1 >= 4
          ? todayLocal.getUTCFullYear()
          : todayLocal.getUTCFullYear() - 1;
      return withInstants({
        from: new Date(Date.UTC(year, 3, 1)),
        to: todayLocal,
        label: `FY ${year}-${String((year + 1) % 100).padStart(2, '0')}`,
      });
    }
    case 'custom':
      return withInstants({
        from: custom?.from ? startOfDay(custom.from) : addDays(todayLocal, -29),
        to: custom?.to ? startOfDay(custom.to) : todayLocal,
        label: 'Custom range',
      });
  }
}

/** Midday on a business day, so a zone offset cannot push it into another. */
function noonOn(day: Date): Date {
  return new Date(day.getTime() + 12 * 3_600_000);
}

export interface DashboardSummary {
  range: { from: string; to: string; label: string };
  members: {
    total: number;
    active: number;
    expired: number;
    expiringIn7Days: number;
    newInRange: number;
    inactive30Days: number;
  };
  attendance: { today: number; inRange: number; averagePerDay: number };
  money: {
    collectedInRange: string;
    outstanding: string;
    expensesInRange: string;
    netInRange: string;
  };
  leads: { open: number; newInRange: number; convertedInRange: number; conversionRate: number };
  retention: { renewalRate: number; renewedInRange: number; dueInRange: number };
}

export async function getDashboardSummary(
  ctx: DashboardContext,
  permissions: ResolvedPermissions,
  options: { range?: DateRangeKey; from?: string; to?: string; branchId?: string } = {},
): Promise<DashboardSummary> {
  requirePermission(permissions, 'analytics.dashboard.read');

  const range = resolveRange(options.range ?? 'last30', { from: options.from, to: options.to });
  const todayLocal = businessDay();
  // Timestamps are compared against the real instants the business days
  // cover; date-only columns keep using the dates themselves.
  const rangeEnd = range.toInstant;
  const branchWhere = options.branchId ? { branchId: options.branchId } : {};

  return withTenant(ctx, async (tx) => {
    const [
      total,
      active,
      expired,
      expiringSoon,
      newInRange,
      inactive30,
      attendanceToday,
      attendanceInRange,
      collected,
      outstanding,
      expenses,
      openLeads,
      newLeads,
      convertedLeads,
      renewals,
      dueForRenewal,
    ] = await Promise.all([
      tx.member.count({ where: { deletedAt: null, ...branchWhere } }),
      tx.member.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          membershipExpiresAt: { gte: todayLocal },
          ...branchWhere,
        },
      }),
      tx.member.count({
        where: { deletedAt: null, membershipExpiresAt: { lt: todayLocal }, ...branchWhere },
      }),
      tx.member.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          membershipExpiresAt: { gte: todayLocal, lte: addDays(todayLocal, 7) },
          ...branchWhere,
        },
      }),
      tx.member.count({
        where: {
          deletedAt: null,
          joiningDate: { gte: range.from, lte: range.to },
          ...branchWhere,
        },
      }),
      tx.member.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          OR: [{ lastVisitAt: null }, { lastVisitAt: { lt: addDays(todayLocal, -30) } }],
          ...branchWhere,
        },
      }),
      tx.attendance.count({ where: { attendanceDate: todayLocal, ...branchWhere } }),
      tx.attendance.count({
        where: { attendanceDate: { gte: range.from, lte: range.to }, ...branchWhere },
      }),
      tx.payment.aggregate({
        where: {
          status: 'CAPTURED',
          receivedAt: { gte: range.fromInstant, lt: rangeEnd },
          ...branchWhere,
        },
        _sum: { amount: true },
      }),
      tx.member.aggregate({
        where: { deletedAt: null, ...branchWhere },
        _sum: { outstandingAmount: true },
      }),
      tx.expense.aggregate({
        where: {
          deletedAt: null,
          expenseDate: { gte: range.from, lte: range.to },
          ...branchWhere,
        },
        _sum: { totalAmount: true },
      }),
      tx.lead.count({
        where: { deletedAt: null, status: { notIn: ['CONVERTED', 'LOST'] }, ...branchWhere },
      }),
      tx.lead.count({
        where: {
          deletedAt: null,
          createdAt: { gte: range.fromInstant, lt: rangeEnd },
          ...branchWhere,
        },
      }),
      tx.lead.count({
        where: {
          deletedAt: null,
          status: 'CONVERTED',
          convertedAt: { gte: range.fromInstant, lt: rangeEnd },
          ...branchWhere,
        },
      }),
      tx.subscriptionEvent.count({
        where: { eventType: 'RENEWED', createdAt: { gte: range.fromInstant, lt: rangeEnd } },
      }),
      tx.subscription.count({
        where: {
          deletedAt: null,
          endDate: { gte: range.from, lte: range.to },
          ...branchWhere,
        },
      }),
    ]);

    const collectedPaise = toPaise((collected._sum.amount ?? 0).toString());
    const expensesPaise = toPaise((expenses._sum.totalAmount ?? 0).toString());
    const days = Math.max(
      1,
      Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000) + 1,
    );

    return {
      range: {
        from: range.from.toISOString().slice(0, 10),
        to: range.to.toISOString().slice(0, 10),
        label: range.label,
      },
      members: {
        total,
        active,
        expired,
        expiringIn7Days: expiringSoon,
        newInRange,
        inactive30Days: inactive30,
      },
      attendance: {
        today: attendanceToday,
        inRange: attendanceInRange,
        averagePerDay: Math.round((attendanceInRange / days) * 10) / 10,
      },
      money: {
        collectedInRange: toRupees(collectedPaise),
        outstanding: toRupees(toPaise((outstanding._sum.outstandingAmount ?? 0).toString())),
        expensesInRange: toRupees(expensesPaise),
        netInRange: toRupees(collectedPaise - expensesPaise),
      },
      leads: {
        open: openLeads,
        newInRange: newLeads,
        convertedInRange: convertedLeads,
        conversionRate: newLeads === 0 ? 0 : Math.round((convertedLeads / newLeads) * 100),
      },
      retention: {
        renewedInRange: renewals,
        dueInRange: dueForRenewal,
        renewalRate: dueForRenewal === 0 ? 0 : Math.round((renewals / dueForRenewal) * 100),
      },
    };
  });
}

// --------------------------------------------------------------- charts ---

export interface SeriesPoint {
  period: string;
  value: number;
}

/**
 * Monthly revenue, attendance and joins in one pass each.
 *
 * `generate_series` fills the empty months, so a chart with a quiet July
 * shows a gap at zero rather than silently skipping it and misleading the
 * eye about the trend.
 *
 * The `::int` casts are load-bearing: Prisma sends a JavaScript number as
 * int8, and `make_interval(months => int8)` is not a function PostgreSQL has.
 */
export async function getCharts(
  ctx: DashboardContext,
  permissions: ResolvedPermissions,
  options: { months?: number; branchId?: string } = {},
): Promise<{
  revenue: SeriesPoint[];
  attendance: SeriesPoint[];
  joins: SeriesPoint[];
  planMix: Array<{ label: string; value: number }>;
  collectionByMethod: Array<{ label: string; value: number }>;
}> {
  requirePermission(permissions, 'analytics.dashboard.read');
  const months = Math.min(options.months ?? 12, 36);

  return withTenant(ctx, async (tx) => {
    const [revenue, attendance, joins, planMix, methods] = await Promise.all([
      tx.$queryRaw<Array<{ period: string; value: number }>>`
        WITH months AS (
          SELECT to_char(d, 'YYYY-MM') AS period, d::date AS start
            FROM generate_series(
              date_trunc('month', CURRENT_DATE) - make_interval(months => ${months - 1}::int),
              date_trunc('month', CURRENT_DATE),
              '1 month'
            ) AS d
        )
        SELECT m.period,
               COALESCE(SUM(p."amount"), 0)::float8 AS value
          FROM months m
          LEFT JOIN payments p
            ON date_trunc('month', p."receivedAt") = m.start
           AND p."status" = 'CAPTURED'
         GROUP BY m.period
         ORDER BY m.period`,

      tx.$queryRaw<Array<{ period: string; value: number }>>`
        WITH months AS (
          SELECT to_char(d, 'YYYY-MM') AS period, d::date AS start
            FROM generate_series(
              date_trunc('month', CURRENT_DATE) - make_interval(months => ${months - 1}::int),
              date_trunc('month', CURRENT_DATE),
              '1 month'
            ) AS d
        )
        SELECT m.period, COUNT(a.id)::float8 AS value
          FROM months m
          LEFT JOIN attendance a
            ON date_trunc('month', a."attendanceDate") = m.start
         GROUP BY m.period
         ORDER BY m.period`,

      tx.$queryRaw<Array<{ period: string; value: number }>>`
        WITH months AS (
          SELECT to_char(d, 'YYYY-MM') AS period, d::date AS start
            FROM generate_series(
              date_trunc('month', CURRENT_DATE) - make_interval(months => ${months - 1}::int),
              date_trunc('month', CURRENT_DATE),
              '1 month'
            ) AS d
        )
        SELECT m.period, COUNT(mem.id)::float8 AS value
          FROM months m
          LEFT JOIN members mem
            ON date_trunc('month', mem."joiningDate") = m.start
           AND mem."deletedAt" IS NULL
         GROUP BY m.period
         ORDER BY m.period`,

      tx.subscription.groupBy({
        by: ['planId'],
        where: { status: 'ACTIVE', deletedAt: null },
        _count: true,
      }),

      tx.payment.groupBy({
        by: ['method'],
        where: {
          status: 'CAPTURED',
          receivedAt: { gte: addDays(businessDay(), -89) },
        },
        _sum: { amount: true },
      }),
    ]);

    const planIds = planMix.map((row: any) => row.planId);
    const plans = planIds.length
      ? await tx.membershipPlan.findMany({
          where: { id: { in: planIds } },
          select: { id: true, name: true },
        })
      : [];
    const planNames = new Map(plans.map((plan: any) => [plan.id, plan.name]));

    return {
      revenue: revenue.map((row) => ({ period: row.period, value: Number(row.value) })),
      attendance: attendance.map((row) => ({ period: row.period, value: Number(row.value) })),
      joins: joins.map((row) => ({ period: row.period, value: Number(row.value) })),
      planMix: planMix
        .map((row: any) => ({
          label: planNames.get(row.planId) ?? 'Unknown plan',
          value: row._count,
        }))
        .sort((a: any, b: any) => b.value - a.value),
      collectionByMethod: methods
        .map((row: any) => ({
          label: row.method,
          value: Number((row._sum.amount ?? 0).toString()),
        }))
        .sort((a: any, b: any) => b.value - a.value),
    };
  });
}

/** Who to call today: expiring soon, overdue, and gone quiet. */
export async function getActionLists(
  ctx: DashboardContext,
  permissions: ResolvedPermissions,
  options: { limit?: number } = {},
) {
  requirePermission(permissions, 'analytics.dashboard.read');
  const limit = Math.min(options.limit ?? 10, 50);
  const todayLocal = businessDay();

  return withTenant(ctx, async (tx) => {
    const [expiring, overdue, quiet] = await Promise.all([
      tx.member.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          membershipExpiresAt: { gte: todayLocal, lte: addDays(todayLocal, 7) },
        },
        orderBy: { membershipExpiresAt: 'asc' },
        take: limit,
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          phone: true,
          membershipExpiresAt: true,
        },
      }),
      tx.member.findMany({
        where: { deletedAt: null, outstandingAmount: { gt: 0 } },
        orderBy: { outstandingAmount: 'desc' },
        take: limit,
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          phone: true,
          outstandingAmount: true,
        },
      }),
      tx.member.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          membershipExpiresAt: { gte: todayLocal },
          OR: [{ lastVisitAt: null }, { lastVisitAt: { lt: addDays(todayLocal, -14) } }],
        },
        orderBy: { lastVisitAt: 'asc' },
        take: limit,
        select: {
          id: true,
          memberCode: true,
          firstName: true,
          lastName: true,
          phone: true,
          lastVisitAt: true,
        },
      }),
    ]);

    const name = (row: any) => [row.firstName, row.lastName].filter(Boolean).join(' ');

    return {
      expiringSoon: expiring.map((row: any) => ({
        id: row.id,
        memberCode: row.memberCode,
        name: name(row),
        phone: row.phone,
        expiresAt: row.membershipExpiresAt,
      })),
      overdue: overdue.map((row: any) => ({
        id: row.id,
        memberCode: row.memberCode,
        name: name(row),
        phone: row.phone,
        amount: row.outstandingAmount.toString(),
      })),
      goneQuiet: quiet.map((row: any) => ({
        id: row.id,
        memberCode: row.memberCode,
        name: name(row),
        phone: row.phone,
        lastVisitAt: row.lastVisitAt,
      })),
    };
  });
}
