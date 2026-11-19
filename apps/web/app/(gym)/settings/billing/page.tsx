import type { Metadata } from 'next';
import { getTenantBilling, listSignupPlans } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { Badge, Card, EmptyState, PageHeader, StatTile, rupees } from '@/components/ui';
import { PlanPanel } from './panel';

export const metadata: Metadata = { title: 'Subscription' };
export const dynamic = 'force-dynamic';

/**
 * The gym's own subscription.
 *
 * Leads with what they are using against what they are paying for, because
 * that is the honest basis for a plan decision — and because a gym finding
 * out it is near a limit from an error message at the front desk is a gym
 * that was badly served.
 */
export default async function BillingPage() {
  const { session, actor, ctx } = await requireActor('/settings/billing');

  const [billing, plans] = await Promise.all([
    getTenantBilling(ctx, actor.permissions),
    listSignupPlans(),
  ]);

  const canChange = holds(session, 'org.billing.update');
  const onTrial = billing.status === 'TRIAL';

  const usage = [
    { label: 'Members', ...billing.usage.members },
    { label: 'Branches', ...billing.usage.branches },
    { label: 'Team', ...billing.usage.staff },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Subscription"
        subtitle={`${billing.planName} · ${rupees(billing.monthlyPrice)} a month`}
        action={
          <Badge
            tone={
              billing.isReadOnly
                ? 'expired'
                : onTrial
                  ? 'expiring'
                  : billing.status === 'ACTIVE'
                    ? 'active'
                    : 'frozen'
            }
          >
            {billing.isReadOnly ? 'Read-only' : billing.status.toLowerCase().replace('_', ' ')}
          </Badge>
        }
      />

      {billing.isReadOnly && (
        <div
          role="alert"
          className="rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-base text-ink"
        >
          <p className="font-medium">
            This gym is read-only until the subscription is paid.
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            Every member, invoice and attendance record is still here, and you can{' '}
            <a href="/settings/export" className="underline underline-offset-2">
              download all of it
            </a>{' '}
            right now. You cannot register members or take payments until the account is
            settled — nothing has been deleted, and nothing will be.
          </p>
        </div>
      )}

      {onTrial && (
        <div className="rounded-card border border-line bg-canvas px-4 py-3 text-base text-ink">
          <p>
            {billing.daysLeft > 0
              ? `${billing.daysLeft} ${billing.daysLeft === 1 ? 'day' : 'days'} left of your trial.`
              : 'Your trial has ended.'}
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            When it ends, the gym goes read-only rather than being locked: you keep everything
            and can{' '}
            <a href="/settings/export" className="underline underline-offset-2">
              export it
            </a>{' '}
            at any time.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {usage.map((row) => (
          <StatTile
            key={row.label}
            label={row.label}
            value={row.limit === null ? row.used : `${row.used} / ${row.limit}`}
            tone={
              row.limit !== null && row.used >= row.limit
                ? 'warn'
                : row.limit !== null && row.used >= row.limit * 0.8
                  ? 'warn'
                  : 'default'
            }
            hint={row.limit === null ? 'Unlimited' : 'On this plan'}
          />
        ))}
      </div>

      {canChange && (
        <PlanPanel
          currentPlanKey={billing.planKey}
          plans={plans.map((plan) => ({
            key: plan.key,
            name: plan.name,
            tagline: plan.tagline,
            monthlyPrice: plan.monthlyPrice,
          }))}
        />
      )}

      <Card title="Invoices" description="What this gym has been billed for the software" padded={false}>
        {billing.invoices.length === 0 ? (
          <EmptyState
            title="Nothing billed yet"
            description="Invoices appear here once the trial ends and the first period is billed."
          />
        ) : (
          <ul className="divide-y divide-line">
            {billing.invoices.map((invoice) => (
              <li
                key={invoice.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-ink">{invoice.code}</p>
                  <p className="truncate text-sm text-ink-muted">{invoice.period}</p>
                </div>
                <span className="text-base font-medium text-ink">{rupees(invoice.total)}</span>
                <Badge tone={invoice.status === 'PAID' ? 'active' : 'expiring'}>
                  {invoice.status.toLowerCase().replace('_', ' ')}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
