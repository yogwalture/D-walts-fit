import type { Metadata } from 'next';
import Link from 'next/link';
import { listInvoices } from '@gym/core';
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
import { InvoiceFilters } from './filters';

export const metadata: Metadata = { title: 'Invoices' };
export const dynamic = 'force-dynamic';

const STATUSES = ['all', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'];

const TONES: Record<string, 'active' | 'expiring' | 'expired' | 'neutral'> = {
  PAID: 'active',
  PARTIALLY_PAID: 'expiring',
  ISSUED: 'expiring',
  OVERDUE: 'expired',
  CANCELLED: 'neutral',
  DRAFT: 'neutral',
};

/**
 * Invoices.
 *
 * Each row opens its PDF, because that is what someone comes here to do:
 * a member is at the desk asking for last month's bill, or the accountant
 * wants the GST paperwork for the quarter.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx } = await requireActor('/finance/invoices');
  const params = await searchParams;

  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const requested = one('status') ?? 'all';
  const status = STATUSES.includes(requested) ? requested : 'all';
  const page = Math.max(1, Number(one('page') ?? 1) || 1);
  const search = one('q');

  const { rows, total, totals } = await listInvoices(ctx, actor.permissions, {
    page,
    pageSize: 25,
    status,
    search,
  });

  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Invoices"
        subtitle={`${total.toLocaleString('en-IN')} in this view`}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile label="Billed" value={rupees(totals.billed)} hint="In this view" />
        <StatTile
          label="Still owed"
          value={rupees(totals.due)}
          tone={Number(totals.due) > 0 ? 'warn' : 'good'}
          hint="In this view"
        />
      </div>

      <InvoiceFilters status={status} search={search ?? ''} />

      <Card padded={false}>
        <DataTable
          rows={rows}
          empty={
            <EmptyState
              title={search ? 'No invoice matches that' : 'Nothing billed in this view'}
              description={
                search
                  ? 'Try the invoice number, or the member’s name or code.'
                  : 'Selling a membership raises a tax invoice automatically.'
              }
            />
          }
          columns={[
            {
              key: 'code',
              header: 'Invoice',
              cell: (row) => (
                <a
                  href={`/api/v1/finance/invoices/${row.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium tabular-nums text-accent hover:underline"
                >
                  {row.invoiceCode}
                </a>
              ),
            },
            {
              key: 'member',
              header: 'Member',
              cell: (row) =>
                row.memberId ? (
                  <Link href={`/members/${row.memberId}`} className="text-ink hover:underline">
                    {row.memberName}
                  </Link>
                ) : (
                  <span className="text-ink-muted">Walk-in</span>
                ),
            },
            {
              key: 'issued',
              header: 'Issued',
              hideOnMobile: true,
              cell: (row) => <span className="text-ink-muted">{shortDate(row.issueDate)}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (
                <Badge tone={TONES[row.status] ?? 'neutral'}>
                  {row.status.toLowerCase().replace('_', ' ')}
                </Badge>
              ),
            },
            {
              key: 'due',
              header: 'Owed',
              align: 'right',
              hideOnMobile: true,
              cell: (row) =>
                Number(row.amountDue) > 0 ? (
                  <span className="font-medium tabular-nums text-amber-700">
                    {rupees(row.amountDue)}
                  </span>
                ) : (
                  <span className="text-ink-subtle">—</span>
                ),
            },
            {
              key: 'total',
              header: 'Total',
              align: 'right',
              cell: (row) => (
                <span className="font-medium tabular-nums text-ink">{rupees(row.total)}</span>
              ),
            },
          ]}
        />
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          {page > 1 ? (
            <Link href={`/finance/invoices?status=${status}&page=${page - 1}`} className="btn-ghost">
              Previous
            </Link>
          ) : (
            <span className="btn-ghost pointer-events-none opacity-40">Previous</span>
          )}
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={`/finance/invoices?status=${status}&page=${page + 1}`} className="btn-ghost">
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
