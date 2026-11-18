import type { Metadata } from 'next';
import { expensesByCategory, listExpenseCategories, listExpenses, businessDayIso } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import {
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatTile,
  rupees,
  shortDate,
  spoken,
} from '@/components/ui';
import { MixChart } from '@/components/charts';
import { NewExpensePanel } from './new-expense-panel';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

/**
 * What the gym spends.
 *
 * Without this the dashboard's "net" is revenue wearing a different label.
 * The split by category is the part an owner actually studies — rent and
 * salaries are fixed, and everything else is where a month goes wrong.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/finance/expenses');
  const params = await searchParams;

  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const page = Math.max(1, Number(one('page') ?? 1) || 1);
  const canManage = holds(session, 'finance.expense.manage');

  // This month so far, which is the question being asked when someone opens
  // this page in the last week of a month.
  const today = businessDayIso();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [{ rows, total, totals }, byCategory, categories] = await Promise.all([
    listExpenses(ctx, actor.permissions, { page, pageSize: 25 }),
    expensesByCategory(ctx, actor.permissions, { fromDate: monthStart, toDate: today }),
    canManage ? listExpenseCategories(ctx, actor.permissions) : Promise.resolve([]),
  ]);

  const monthTotal = byCategory.reduce((sum, row) => sum + row.value, 0);
  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Expenses"
        subtitle={`${total.toLocaleString('en-IN')} recorded`}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="This month" value={rupees(monthTotal)} hint="So far" />
        <StatTile label="All recorded" value={rupees(totals.grand)} />
        <StatTile
          label="Tax paid"
          value={rupees(totals.tax)}
          hint="Claimable as input credit"
        />
      </div>

      {canManage && <NewExpensePanel categories={categories} today={today} />}

      {byCategory.length > 0 && (
        <Card title="Where this month went">
          <MixChart data={byCategory} />
        </Card>
      )}

      <Card title="All expenses" padded={false}>
        <DataTable
          rows={rows}
          empty={
            <EmptyState
              title="Nothing recorded yet"
              description="Rent, salaries, electricity, equipment — recording them is what makes the dashboard's net figure mean anything."
            />
          }
          columns={[
            {
              key: 'title',
              header: 'What for',
              cell: (row) => (
                <span>
                  <span className="font-medium text-ink">{row.title}</span>
                  {row.categoryName && (
                    <span className="block text-sm text-ink-muted">{row.categoryName}</span>
                  )}
                </span>
              ),
            },
            {
              key: 'date',
              header: 'When',
              cell: (row) => <span className="text-ink-muted">{shortDate(row.expenseDate)}</span>,
            },
            {
              key: 'method',
              header: 'Paid by',
              hideOnMobile: true,
              cell: (row) => (
                <span className="text-ink-muted">
                  {spoken(row.method)}
                  {row.referenceNumber && (
                    <span className="block text-sm tabular-nums text-ink-subtle">
                      {row.referenceNumber}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'tax',
              header: 'Tax',
              align: 'right',
              hideOnMobile: true,
              cell: (row) =>
                Number(row.taxAmount) > 0 ? (
                  <span className="tabular-nums text-ink-muted">{rupees(row.taxAmount)}</span>
                ) : (
                  <span className="text-ink-subtle">—</span>
                ),
            },
            {
              key: 'total',
              header: 'Total',
              align: 'right',
              cell: (row) => (
                <span className="font-medium tabular-nums text-ink">{rupees(row.totalAmount)}</span>
              ),
            },
          ]}
        />
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          <a
            href={`/finance/expenses?page=${page - 1}`}
            className={page > 1 ? 'btn-ghost' : 'btn-ghost pointer-events-none opacity-40'}
          >
            Previous
          </a>
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          <a
            href={`/finance/expenses?page=${page + 1}`}
            className={page < totalPages ? 'btn-ghost' : 'btn-ghost pointer-events-none opacity-40'}
          >
            Next
          </a>
        </nav>
      )}
    </div>
  );
}
