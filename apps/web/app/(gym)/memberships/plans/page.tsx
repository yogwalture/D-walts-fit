import type { Metadata } from 'next';
import { withTenant } from '@gym/db';
import { listPlans } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { Badge, Card, DataTable, EmptyState, PageHeader } from '@/components/ui';
import { NewPlanPanel } from './new-plan-panel';

export const metadata: Metadata = { title: 'Plans' };
export const dynamic = 'force-dynamic';

/**
 * Membership plans.
 *
 * Every plan carries its own grace period, freeze allowance and tax rate, so
 * a gym can run a strict annual plan and a generous monthly one side by side
 * without any of it being hardcoded.
 */
export default async function PlansPage() {
  const { session, actor, ctx } = await requireActor('/memberships/plans');
  const canManage = holds(session, 'memberships.plan.manage');

  const [plans, taxRates] = await Promise.all([
    listPlans(ctx, actor.permissions, { includeInactive: canManage }),
    canManage
      ? withTenant(ctx, (tx) =>
          tx.taxRate.findMany({
            where: { isActive: true },
            select: { id: true, name: true, percentage: true, isDefault: true },
            orderBy: [{ isDefault: 'desc' }, { percentage: 'asc' }],
          }),
        )
      : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Plans"
        subtitle={`${plans.length} ${plans.length === 1 ? 'plan' : 'plans'}`}
      />

      {canManage && (
        <NewPlanPanel
          taxRates={taxRates.map((rate) => ({
            id: rate.id,
            name: rate.name,
            percentage: rate.percentage.toString(),
            isDefault: rate.isDefault,
          }))}
        />
      )}

      <Card padded={false}>
        <DataTable
          rows={plans}
          empty={
            <EmptyState
              title="No plans yet"
              description="A plan sets the price, how long it runs, the grace period and whether it can be frozen. Create one to start selling memberships."
            />
          }
          columns={[
            {
              key: 'name',
              header: 'Plan',
              cell: (row) => (
                <span>
                  <span className="font-medium text-ink">{row.name}</span>
                  {!row.isActive && (
                    <span className="ml-2">
                      <Badge tone="neutral">retired</Badge>
                    </span>
                  )}
                  {row.description && (
                    <span className="block text-sm text-ink-muted">{row.description}</span>
                  )}
                </span>
              ),
            },
            {
              key: 'duration',
              header: 'Runs for',
              cell: (row) => <span className="text-ink-muted">{row.durationLabel}</span>,
            },
            {
              key: 'price',
              header: 'Price',
              align: 'right',
              cell: (row) => (
                <span>
                  <span className="font-medium tabular-nums text-ink">{row.priceDisplay}</span>
                  {row.taxLabel && (
                    <span className="block text-sm text-ink-subtle">{row.taxLabel}</span>
                  )}
                </span>
              ),
            },
            {
              key: 'terms',
              header: 'Terms',
              hideOnMobile: true,
              cell: (row) => (
                <span className="text-sm text-ink-muted">
                  {row.graceDays > 0 ? `${row.graceDays}-day grace` : 'No grace'}
                  {row.freezeAllowed ? ' · freezable' : ''}
                </span>
              ),
            },
            {
              key: 'members',
              header: 'On this plan',
              align: 'right',
              cell: (row) => (
                <span className="tabular-nums text-ink">{row.activeSubscriptions}</span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
