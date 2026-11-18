import type { Metadata } from 'next';
import {
  collectionsReport,
  taxReport,
  outstandingDues,
  membershipReport,
  businessDayIso,
} from '@gym/core';
import { requireActor } from '@/lib/current-session';
import { Card, EmptyState, PageHeader, StatTile, rupees } from '@/components/ui';
import { ReportControls } from './controls';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

/** The first of the current month, in the gym's own day rather than UTC. */
function monthStart(): string {
  const today = businessDayIso();
  return `${today.slice(0, 7)}-01`;
}

/**
 * Reports.
 *
 * The dashboard answers "how are we doing"; this answers "what do I give the
 * accountant". So the GST summary is by rate — a return is filed by rate,
 * and one figure for tax collected cannot be filed at all — and everything
 * downloads as the same numbers in a file.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx } = await requireActor('/reports');

  const params = await searchParams;
  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const from = one('from') ?? monthStart();
  const to = one('to') ?? businessDayIso();

  const [collections, tax, dues, memberships] = await Promise.all([
    collectionsReport(ctx, actor.permissions, { from, to }),
    taxReport(ctx, actor.permissions, { from, to }),
    outstandingDues(ctx, actor.permissions, {}),
    membershipReport(ctx, actor.permissions, { from, to }),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Reports" subtitle={`${from} to ${to}`} />

      <ReportControls from={from} to={to} />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Collected" value={rupees(collections.total)} hint={`${collections.count} payments`} />
        <StatTile label="GST collected" value={rupees(tax.tax)} hint="On what was invoiced" />
        <StatTile
          label="Outstanding"
          value={rupees(dues.total)}
          tone={Number(dues.total) > 0 ? 'warn' : 'good'}
          hint={`${dues.rows.length} members`}
        />
        <StatTile
          label="Renewal rate"
          value={`${memberships.renewalRate}%`}
          hint="Of those that came up"
        />
      </div>

      <Card
        title="GST summary"
        description="By rate, which is how a return is filed"
        padded={false}
      >
        {tax.byRate.length === 0 ? (
          <EmptyState title="Nothing invoiced in this period" description="Pick another range." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead className="border-b border-line text-sm text-ink-subtle">
                <tr>
                  <th className="px-5 py-2 text-left font-medium">Rate</th>
                  <th className="px-5 py-2 text-right font-medium">Taxable</th>
                  <th className="px-5 py-2 text-right font-medium">CGST</th>
                  <th className="px-5 py-2 text-right font-medium">SGST</th>
                  <th className="px-5 py-2 text-right font-medium">IGST</th>
                  <th className="px-5 py-2 text-right font-medium">Total</th>
                  <th className="px-5 py-2 text-right font-medium">Invoices</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tax.byRate.map((rate) => (
                  <tr key={rate.ratePercent}>
                    <td className="px-5 py-2.5">{rate.ratePercent}%</td>
                    <td className="px-5 py-2.5 text-right">{rupees(rate.taxable)}</td>
                    <td className="px-5 py-2.5 text-right">{rupees(rate.cgst)}</td>
                    <td className="px-5 py-2.5 text-right">{rupees(rate.sgst)}</td>
                    <td className="px-5 py-2.5 text-right">{rupees(rate.igst)}</td>
                    <td className="px-5 py-2.5 text-right font-medium">{rupees(rate.total)}</td>
                    <td className="px-5 py-2.5 text-right text-ink-muted">{rate.invoices}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Collected, by method" description="What the drawer should agree with" padded={false}>
          {collections.byMethod.length === 0 ? (
            <EmptyState title="Nothing collected" description="In this date range." />
          ) : (
            <ul className="divide-y divide-line">
              {collections.byMethod.map((method) => (
                <li key={method.method} className="flex items-center justify-between px-5 py-2.5">
                  <span className="text-base text-ink">
                    {method.method.replace('_', ' ').toLowerCase()}
                  </span>
                  <span className="text-sm text-ink-muted">{method.count}</span>
                  <span className="text-base font-medium text-ink">{rupees(method.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Collected, by who took it" description="How a shortfall is traced" padded={false}>
          <ul className="divide-y divide-line">
            {collections.byStaff.map((staff) => (
              <li key={staff.name} className="flex items-center justify-between px-5 py-2.5">
                <span className="truncate text-base text-ink">{staff.name}</span>
                <span className="text-base font-medium text-ink">{rupees(staff.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title="What is owed"
        description="Grouped by member, oldest first — a gym rings a person, not a document"
        padded={false}
      >
        {dues.rows.length === 0 ? (
          <EmptyState title="Nobody owes anything" description="Every invoice is settled." />
        ) : (
          <ul className="divide-y divide-line">
            {dues.rows.slice(0, 25).map((row) => (
              <li key={row.memberId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-ink">{row.name}</p>
                  <p className="truncate text-sm text-ink-muted">
                    {row.memberCode} · {row.phone} · {row.invoices} invoice
                    {row.invoices === 1 ? '' : 's'}
                  </p>
                </div>
                <span className="text-sm text-ink-muted">
                  {row.daysOverdue > 0 ? `${row.daysOverdue} days` : 'due today'}
                </span>
                <span className="text-base font-medium text-ink">{rupees(row.amountDue)}</span>
                <a href={`tel:${row.phone}`} className="text-base text-accent hover:underline">
                  Call
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Memberships" description={`${memberships.sold} sold in this range`} padded={false}>
        <ul className="divide-y divide-line">
          {memberships.byPlan.map((plan) => (
            <li key={plan.planName} className="flex items-center justify-between px-5 py-2.5">
              <span className="truncate text-base text-ink">{plan.planName}</span>
              <span className="text-sm text-ink-muted">{plan.sold} sold</span>
              <span className="text-base font-medium text-ink">{rupees(plan.revenue)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between px-5 py-2.5 text-sm text-ink-muted">
            <span>
              {memberships.firstTime} first-time, {memberships.renewals} renewals,{' '}
              {memberships.expired} ended
            </span>
          </li>
        </ul>
      </Card>
    </div>
  );
}
