import { NextResponse } from 'next/server';
import { reportExportQuery } from '@gym/contracts';
import {
  collectionsReport,
  taxReport,
  outstandingDues,
  membershipReport,
  toCsv,
  businessDayIso,
} from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The same figures as the screen, as a file.
 *
 * Built from the same services, so the file and the page cannot disagree —
 * and sent with no-store, because a report is somebody's financial position
 * and has no business in a shared cache.
 */
export const GET = route(
  { permission: 'finance.report.read', source: 'query', schema: reportExportQuery },
  async ({ input, actor }) => {
    const ctx = tenantOf(actor);
    const from = input.from ?? businessDayIso();
    const to = input.to ?? businessDayIso();

    let rows: Array<Record<string, unknown>>;
    let name = input.kind;

    if (input.kind === 'collections') {
      const report = await collectionsReport(ctx, actor.permissions, {
        from,
        to,
        branchId: input.branchId,
      });
      rows = report.byDay.map((day) => ({
        date: day.date,
        payments: day.count,
        amount: day.amount,
      }));
      name = `collections-${from}-to-${to}` as typeof name;
    } else if (input.kind === 'tax') {
      const report = await taxReport(ctx, actor.permissions, { from, to });
      rows = report.byRate.map((rate) => ({
        rate_percent: rate.ratePercent,
        taxable: rate.taxable,
        cgst: rate.cgst,
        sgst: rate.sgst,
        igst: rate.igst,
        tax: rate.tax,
        total: rate.total,
        invoices: rate.invoices,
      }));
      name = `gst-${from}-to-${to}` as typeof name;
    } else if (input.kind === 'dues') {
      const report = await outstandingDues(ctx, actor.permissions, {
        branchId: input.branchId,
      });
      rows = report.rows.map((row) => ({
        member_code: row.memberCode,
        name: row.name,
        phone: row.phone,
        invoices: row.invoices,
        oldest_due: row.oldestDueDate,
        days_overdue: row.daysOverdue,
        amount_due: row.amountDue,
      }));
      name = 'outstanding-dues' as typeof name;
    } else {
      const report = await membershipReport(ctx, actor.permissions, {
        from,
        to,
        branchId: input.branchId,
      });
      rows = report.byPlan.map((plan) => ({
        plan: plan.planName,
        sold: plan.sold,
        revenue: plan.revenue,
      }));
      name = `memberships-${from}-to-${to}` as typeof name;
    }

    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}.csv"`,
        // A report is somebody's financial position and has no business in
        // a shared cache.
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
      },
    });
  },
);
