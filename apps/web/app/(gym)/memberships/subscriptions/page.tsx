import type { Metadata } from 'next';
import Link from 'next/link';
import { listSubscriptions } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  rupees,
  shortDate,
} from '@/components/ui';
import { SubscriptionFilters } from './filters';
import { SubscriptionActions } from './actions';

export const metadata: Metadata = { title: 'Subscriptions' };
export const dynamic = 'force-dynamic';

const STATUSES = ['live', 'ACTIVE', 'FROZEN', 'EXPIRED', 'CANCELLED', 'all'];

/**
 * Memberships, as things to be acted on.
 *
 * The members list answers "who is in this gym". This one answers "which
 * memberships need something doing" — and puts freeze, extend and cancel on
 * the row rather than three screens away, because a member asking to freeze
 * is standing at the desk while you do it.
 */
export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/memberships/subscriptions');
  const params = await searchParams;

  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const requested = one('status') ?? 'live';
  const status = STATUSES.includes(requested) ? requested : 'ACTIVE';
  const page = Math.max(1, Number(one('page') ?? 1) || 1);
  const search = one('q');
  const expiring = one('expiring') === '1';

  const { rows, total } = await listSubscriptions(ctx, actor.permissions, {
    page,
    pageSize: 25,
    status: expiring ? 'ACTIVE' : status,
    search,
    expiringWithinDays: expiring ? 14 : undefined,
  });

  const totalPages = Math.max(1, Math.ceil(total / 25));

  const permissions = {
    freeze: holds(session, 'memberships.subscription.freeze'),
    extend: holds(session, 'memberships.subscription.extend'),
    cancel: holds(session, 'memberships.subscription.cancel'),
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Subscriptions"
        subtitle={`${total.toLocaleString('en-IN')} ${total === 1 ? 'membership' : 'memberships'}`}
      />

      <SubscriptionFilters status={status} search={search ?? ''} expiring={expiring} />

      <Card padded={false}>
        <DataTable
          rows={rows}
          empty={
            <EmptyState
              title={search ? 'Nothing matches that' : 'No memberships in this view'}
              description={
                search
                  ? 'Try a name, member code or phone number.'
                  : 'Change the filter above, or sell a membership from a member’s profile.'
              }
            />
          }
          columns={[
            {
              key: 'member',
              header: 'Member',
              cell: (row) => (
                <span>
                  <Link
                    href={`/members/${row.memberId}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {row.memberName}
                  </Link>
                  <span className="block text-sm tabular-nums text-ink-muted">
                    {row.memberCode}
                  </span>
                </span>
              ),
            },
            {
              key: 'plan',
              header: 'Plan',
              cell: (row) => <span className="text-ink">{row.planName}</span>,
            },
            {
              key: 'period',
              header: 'Until',
              cell: (row) => (
                <span>
                  <span className="text-ink">{shortDate(row.endDate)}</span>
                  {row.status === 'ACTIVE' && (
                    <span className="block text-sm text-ink-muted">
                      {row.daysRemaining < 0
                        ? `${Math.abs(row.daysRemaining)}d overdue`
                        : `${row.daysRemaining}d left`}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (
                <span>
                  <Badge
                    tone={
                      row.status === 'ACTIVE'
                        ? row.daysRemaining <= 7
                          ? 'expiring'
                          : 'active'
                        : row.status === 'FROZEN'
                          ? 'frozen'
                          : row.status === 'EXPIRED'
                            ? 'expired'
                            : 'neutral'
                    }
                  >
                    {row.status.toLowerCase()}
                  </Badge>
                  {row.freezeAllowed && row.freezeDaysUsed > 0 && (
                    <span className="block text-sm text-ink-subtle">
                      {row.freezeDaysUsed}/{row.freezeDaysAllowed}d frozen
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'money',
              header: 'Owed',
              align: 'right',
              hideOnMobile: true,
              cell: (row) =>
                Number(row.dueAmount) > 0 ? (
                  <span className="font-medium tabular-nums text-amber-700">
                    {rupees(row.dueAmount)}
                  </span>
                ) : (
                  <span className="text-ink-subtle">—</span>
                ),
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              cell: (row) => <SubscriptionActions subscription={row} permissions={permissions} />,
            },
          ]}
        />
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          {page > 1 ? (
            <Link
              href={`/memberships/subscriptions?status=${status}&page=${page - 1}`}
              className="btn-ghost"
            >
              Previous
            </Link>
          ) : (
            <span className="btn-ghost pointer-events-none opacity-40">Previous</span>
          )}
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={`/memberships/subscriptions?status=${status}&page=${page + 1}`}
              className="btn-ghost"
            >
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
