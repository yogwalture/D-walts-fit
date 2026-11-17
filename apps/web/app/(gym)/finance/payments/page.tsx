import type { Metadata } from 'next';
import Link from 'next/link';
import { dailyCollection, listPayments } from '@gym/core';
import { requireActor } from '@/lib/current-session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatTile,
  rupees,
  shortDate,
} from '@/components/ui';
import { MixChart } from '@/components/charts';

export const metadata: Metadata = { title: 'Payments' };
export const dynamic = 'force-dynamic';

/**
 * Payments.
 *
 * The top of this page answers the end-of-shift question — what is in the
 * till, split by method, so cash can be counted against it. Below is the
 * ledger itself, every row carrying the receipt number it was issued under.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx } = await requireActor('/finance/payments');
  const params = await searchParams;

  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const page = Math.max(1, Number(one('page') ?? 1) || 1);

  const [collection, { rows, total, totalAmount }] = await Promise.all([
    dailyCollection(ctx, actor.permissions, { date: one('date') }),
    listPayments(ctx, actor.permissions, {
      page,
      pageSize: 25,
      fromDate: one('from'),
      toDate: one('to'),
      method: one('method'),
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / 25));
  const cash = collection.byMethod.find((entry) => entry.method === 'CASH');

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Payments"
        subtitle={`${total.toLocaleString('en-IN')} recorded · ${rupees(totalAmount)} in this view`}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Collected today"
          value={rupees(collection.total)}
          tone="good"
          hint={shortDate(collection.date)}
        />
        <StatTile
          label="Cash to count"
          value={rupees(cash?.amount ?? 0)}
          hint={cash ? `${cash.count} ${cash.count === 1 ? 'payment' : 'payments'}` : 'No cash today'}
        />
        <StatTile
          label="Other methods"
          value={rupees(Number(collection.total) - Number(cash?.amount ?? 0))}
          hint="UPI, card, transfer"
        />
      </div>

      {collection.byMethod.length > 0 && (
        <Card title="Today by method">
          <MixChart
            data={collection.byMethod.map((entry) => ({
              label: entry.method.toLowerCase().replace('_', ' '),
              value: Number(entry.amount),
            }))}
          />
        </Card>
      )}

      <Card title="All payments" padded={false}>
        <DataTable
          rows={rows}
          empty={
            <EmptyState
              title="Nothing recorded yet"
              description="Payments taken at the counter and captured through the gateway both appear here."
            />
          }
          columns={[
            {
              key: 'member',
              header: 'Member',
              cell: (row) =>
                row.memberId ? (
                  <Link
                    href={`/members/${row.memberId}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {row.memberName}
                  </Link>
                ) : (
                  <span className="text-ink-muted">—</span>
                ),
            },
            {
              key: 'receipt',
              header: 'Receipt',
              hideOnMobile: true,
              cell: (row) => <span className="tabular-nums text-ink-muted">{row.receiptCode}</span>,
            },
            {
              key: 'method',
              header: 'How',
              cell: (row) => (
                <span className="text-ink-muted">{row.method.toLowerCase().replace('_', ' ')}</span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              hideOnMobile: true,
              cell: (row) =>
                row.status === 'CAPTURED' ? (
                  <Badge tone="active">received</Badge>
                ) : (
                  <Badge tone="expiring">{row.status.toLowerCase().replace('_', ' ')}</Badge>
                ),
            },
            {
              key: 'date',
              header: 'When',
              cell: (row) => <span className="text-ink-muted">{shortDate(row.receivedAt)}</span>,
            },
            {
              key: 'amount',
              header: 'Amount',
              align: 'right',
              cell: (row) => (
                <span className="font-medium tabular-nums text-ink">{rupees(row.amount)}</span>
              ),
            },
          ]}
        />
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          {page > 1 ? (
            <Link href={`/finance/payments?page=${page - 1}`} className="btn-ghost">
              Previous
            </Link>
          ) : (
            <span className="btn-ghost pointer-events-none opacity-40">Previous</span>
          )}
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={`/finance/payments?page=${page + 1}`} className="btn-ghost">
              Next
            </Link>
          ) : (
            <span className="btn-ghost pointer-events-none opacity-40">Next</span>
          )}
        </nav>
      )}
    </div>
  );
}
