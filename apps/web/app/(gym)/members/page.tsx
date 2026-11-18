import type { Metadata } from 'next';
import Link from 'next/link';
import { listMembers, type MemberFilter } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  membershipTone,
  rupees,
  shortDate,
} from '@/components/ui';
import { MemberFilters } from './filters';

export const metadata: Metadata = { title: 'Members' };
export const dynamic = 'force-dynamic';

const FILTERS: MemberFilter[] = ['all', 'active', 'expiring', 'expired', 'unpaid', 'inactive'];

/**
 * The members list.
 *
 * Search and filter live in the URL, so a receptionist can keep a tab open on
 * "expiring" and refresh it, and a manager can send someone a link to the
 * same view. The rows come from the service, which narrows by the actor's
 * scope — a trainer sees their own members without the page asking.
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/members');
  const params = await searchParams;

  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const requestedFilter = one('filter') ?? 'all';
  const filter = (FILTERS as string[]).includes(requestedFilter)
    ? (requestedFilter as MemberFilter)
    : 'all';

  const page = Math.max(1, Number(one('page') ?? 1) || 1);
  const search = one('q');

  const { rows, total } = await listMembers(ctx, actor.permissions, {
    page,
    pageSize: 25,
    filter,
    search,
  });

  const totalPages = Math.max(1, Math.ceil(total / 25));
  const canSeeMoney = holds(session, 'finance.payment.read');

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Members"
        subtitle={`${total.toLocaleString('en-IN')} ${total === 1 ? 'member' : 'members'}`}
        action={
          holds(session, 'members.member.create') ? (
            <div className="flex items-center gap-2">
              <Link href="/members/import" className="btn-ghost">
                Import
              </Link>
              <Link href="/members/new" className="btn-primary">
                Register member
              </Link>
            </div>
          ) : undefined
        }
      />

      <MemberFilters filter={filter} search={search ?? ''} />

      <Card padded={false}>
        <DataTable
          rows={rows}
          rowHref={(row) => `/members/${row.id}`}
          empty={
            <EmptyState
              title={search ? 'Nobody matches that' : 'No members in this view'}
              description={
                search
                  ? 'Try a different name, member code or phone number.'
                  : 'Change the filter above, or register a member.'
              }
            />
          }
          columns={[
            { key: 'name', header: 'Name', cell: (row) => row.name },
            {
              key: 'code',
              header: 'Code',
              hideOnMobile: true,
              cell: (row) => <span className="tabular-nums text-ink-muted">{row.memberCode}</span>,
            },
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
              key: 'membership',
              header: 'Membership',
              cell: (row) => {
                const { tone, label } = membershipTone(row.membershipExpiresAt);
                return (
                  <span className="flex items-center gap-2">
                    <Badge tone={tone}>{label}</Badge>
                    {row.membershipExpiresAt && (
                      <span className="hidden text-sm text-ink-subtle lg:inline">
                        {shortDate(row.membershipExpiresAt)}
                      </span>
                    )}
                  </span>
                );
              },
            },
            {
              key: 'lastVisit',
              header: 'Last in',
              hideOnMobile: true,
              cell: (row) => (
                <span className="text-ink-muted">
                  {row.lastVisitAt ? shortDate(row.lastVisitAt) : 'Never'}
                </span>
              ),
            },
            ...(canSeeMoney
              ? [
                  {
                    key: 'due',
                    header: 'Owes',
                    align: 'right' as const,
                    cell: (row: (typeof rows)[number]) =>
                      Number(row.outstandingAmount) > 0 ? (
                        <span className="font-medium tabular-nums text-amber-700">
                          {rupees(row.outstandingAmount)}
                        </span>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          <PageLink
            page={page - 1}
            filter={filter}
            search={search}
            disabled={page <= 1}
            label="Previous"
          />
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          <PageLink
            page={page + 1}
            filter={filter}
            search={search}
            disabled={page >= totalPages}
            label="Next"
          />
        </nav>
      )}
    </div>
  );
}

function PageLink({
  page,
  filter,
  search,
  disabled,
  label,
}: {
  page: number;
  filter: string;
  search?: string;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return <span className="btn-ghost pointer-events-none opacity-40">{label}</span>;
  }

  const query = new URLSearchParams({ filter, page: String(page) });
  if (search) query.set('q', search);

  return (
    <Link href={`/members?${query}`} className="btn-ghost">
      {label}
    </Link>
  );
}
