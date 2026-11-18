import type { Metadata } from 'next';
import Link from 'next/link';
import { getPipeline, listLeads, listPlans } from '@gym/core';
import { requireActor, holds, planLock } from '@/lib/current-session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatTile,
  shortDate,
  spoken,
} from '@/components/ui';
import { MixChart } from '@/components/charts';
import { FeatureLocked } from '@/components/plan-gate';
import { LeadFilters } from './filters';
import { NewLeadPanel } from './new-lead-panel';

export const metadata: Metadata = { title: 'Enquiries' };
export const dynamic = 'force-dynamic';

const FILTERS = ['all', 'open', 'overdue', 'today', 'unassigned', 'converted', 'lost'] as const;

const STATUS_TONES: Record<string, 'active' | 'expiring' | 'expired' | 'frozen' | 'neutral'> = {
  NEW: 'frozen',
  CONTACTED: 'neutral',
  FOLLOW_UP: 'expiring',
  TRIAL_BOOKED: 'frozen',
  NEGOTIATION: 'expiring',
  CONVERTED: 'active',
  LOST: 'expired',
};

/**
 * Enquiries.
 *
 * A gym's growth is almost entirely this: someone walks in, asks the price,
 * says they will think about it, and is never called again. So the default
 * view is the open ones ordered by how overdue their follow-up is — the list
 * a gym should work from on a Monday morning, not an alphabetical directory.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/crm/leads');
  const params = await searchParams;

  // The plan, not the role, is what can stop a gym here: Enquiries is a
  // Growth feature. Checking it before the services run means a gym on
  // Starter meets an explanation, not a server error.
  const locked = planLock(session, 'crm.lead.read');
  if (locked) {
    return (
      <FeatureLocked
        feature={locked}
        title="Enquiries"
        blurb="Record every walk-in and phone enquiry, keep a follow-up date against each one, and see how many turn into members."
      />
    );
  }

  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const requested = one('filter') ?? 'open';
  const filter = (FILTERS as readonly string[]).includes(requested)
    ? (requested as (typeof FILTERS)[number])
    : 'open';
  const page = Math.max(1, Number(one('page') ?? 1) || 1);
  const search = one('q');

  const canSeePipeline = holds(session, 'crm.pipeline.read');

  const [{ rows, total }, pipeline, plans] = await Promise.all([
    listLeads(ctx, actor.permissions, { page, pageSize: 25, filter, search }),
    canSeePipeline
      ? getPipeline(ctx, actor.permissions, {})
      : Promise.resolve(null),
    holds(session, 'crm.lead.create') && holds(session, 'memberships.plan.read')
      ? listPlans(ctx, actor.permissions)
      : Promise.resolve([]),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Enquiries"
        subtitle={`${total.toLocaleString('en-IN')} in this view`}
      />

      {pipeline && (
        <div className="grid gap-4 sm:grid-cols-4">
          <StatTile label="Open" value={pipeline.openTotal} hint="Not yet decided" />
          <StatTile
            label="Overdue"
            value={pipeline.overdueTotal}
            tone={pipeline.overdueTotal > 0 ? 'warn' : 'good'}
            hint="Follow-up passed"
          />
          <StatTile label="Due today" value={pipeline.dueTodayTotal} hint="Call these" />
          <StatTile
            label="Conversion"
            value={`${pipeline.conversionRate}%`}
            tone="good"
            hint="Of those decided"
          />
        </div>
      )}

      {holds(session, 'crm.lead.create') && (
        <NewLeadPanel plans={plans.map((plan) => ({ id: plan.id, name: plan.name }))} />
      )}

      <LeadFilters filter={filter} search={search ?? ''} />

      <Card padded={false}>
        <DataTable
          rows={rows}
          rowHref={(row) => `/crm/leads/${row.id}`}
          empty={
            <EmptyState
              title={
                filter === 'overdue'
                  ? 'Nothing overdue'
                  : search
                    ? 'Nothing matches that'
                    : 'No enquiries in this view'
              }
              description={
                filter === 'overdue'
                  ? 'Every open enquiry has been followed up on time.'
                  : 'Record an enquiry when someone walks in or calls — it is the one thing that turns into members.'
              }
            />
          }
          columns={[
            { key: 'name', header: 'Name', cell: (row) => row.fullName },
            {
              key: 'phone',
              header: 'Phone',
              cell: (row) => (
                <a href={`tel:+91${row.phone}`} className="tabular-nums hover:underline">
                  {row.phone}
                </a>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (
                <Badge tone={STATUS_TONES[row.status] ?? 'neutral'}>
                  {row.status.toLowerCase().replace('_', ' ')}
                </Badge>
              ),
            },
            {
              key: 'source',
              header: 'From',
              hideOnMobile: true,
              cell: (row) => (
                <span className="text-ink-muted">
                  {row.source.toLowerCase().replace('_', ' ')}
                </span>
              ),
            },
            {
              key: 'followup',
              header: 'Follow up',
              cell: (row) => {
                if (!row.nextFollowUpAt) {
                  return <span className="text-ink-subtle">—</span>;
                }
                const days = row.daysUntilFollowUp ?? 0;
                return (
                  <span className={days < 0 ? 'font-medium text-amber-700' : 'text-ink-muted'}>
                    {days < 0
                      ? `${Math.abs(days)}d overdue`
                      : days === 0
                        ? 'Today'
                        : shortDate(row.nextFollowUpAt)}
                  </span>
                );
              },
            },
            {
              key: 'assigned',
              header: 'With',
              align: 'right',
              hideOnMobile: true,
              cell: (row) => (
                <span className="text-ink-muted">{row.assignedToName ?? 'Nobody'}</span>
              ),
            },
          ]}
        />
      </Card>

      {pipeline && pipeline.bySource.length > 0 && (
        <Card title="Where enquiries come from" description="Worth knowing before spending on ads">
          <MixChart data={pipeline.bySource} />
        </Card>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          <Link
            href={`/crm/leads?filter=${filter}&page=${page - 1}`}
            className={page > 1 ? 'btn-ghost' : 'btn-ghost pointer-events-none opacity-40'}
          >
            Previous
          </Link>
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          <Link
            href={`/crm/leads?filter=${filter}&page=${page + 1}`}
            className={page < totalPages ? 'btn-ghost' : 'btn-ghost pointer-events-none opacity-40'}
          >
            Next
          </Link>
        </nav>
      )}
    </div>
  );
}
