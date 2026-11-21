import type { Metadata } from 'next';
import Link from 'next/link';
import { listPendingInvitations, listStaff, listTrainers } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatTile,
  shortDate,
} from '@/components/ui';

export const metadata: Metadata = { title: 'Team' };
export const dynamic = 'force-dynamic';

/**
 * The team.
 *
 * Separate from the invitations screen under settings: that one is about
 * access, this one is about people — who trains whom, what they are
 * qualified in, and how many members each carries.
 */
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/staff');
  const params = await searchParams;

  const search = typeof params.q === 'string' ? params.q : undefined;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const [{ rows, total }, trainers, invitations] = await Promise.all([
    listStaff(ctx, actor.permissions, { page, pageSize: 25, search }),
    listTrainers(ctx, actor.permissions),
    listPendingInvitations(ctx, actor.permissions),
  ]);

  const pending = invitations.filter((invitation) => !invitation.isExpired);
  const expired = invitations.filter((invitation) => invitation.isExpired);

  const unassigned = trainers.filter((trainer) => trainer.memberCount === 0).length;
  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Team"
        subtitle={`${total.toLocaleString('en-IN')} ${total === 1 ? 'person' : 'people'}`}
        action={
          holds(session, 'org.user.invite') ? (
            <Link href="/settings/users" className="btn-ghost">
              Invite someone
            </Link>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="On the team"
          value={total}
          hint={
            [
              pending.length > 0 ? `${pending.length} invited` : null,
              // Said out loud, because an owner waiting on a reply to a
              // lapsed invitation waits for ever.
              expired.length > 0 ? `${expired.length} expired` : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
        <StatTile label="Trainers" value={trainers.length} />
        <StatTile
          label="Trainers with no members"
          value={unassigned}
          tone={unassigned > 0 ? 'warn' : 'default'}
          hint={unassigned > 0 ? 'Worth assigning' : undefined}
        />
      </div>

      {invitations.length > 0 && (
        <Card
          title="Invited, not yet joined"
          description="An invited person has no account until they accept, so they are not on the list below yet."
          padded={false}
        >
          <ul className="divide-y divide-line">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-ink">
                    {invitation.fullName ?? invitation.email}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {invitation.fullName ? `${invitation.email} · ` : ''}
                    {invitation.roleName ?? 'No role'}
                    {invitation.invitedBy && ` · invited by ${invitation.invitedBy}`}
                    {` · ${shortDate(invitation.invitedAt)}`}
                  </p>
                </div>
                <Badge tone={invitation.isExpired ? 'expired' : 'expiring'}>
                  {invitation.isExpired
                    ? 'expired'
                    : `expires ${shortDate(invitation.expiresAt)}`}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {trainers.length > 0 && (
        <Card title="Trainers" description="And how many members each carries" padded={false}>
          <DataTable
            rows={trainers}
            rowHref={(row) => `/staff/${row.orgUserId}`}
            empty={<EmptyState title="No trainers yet" description="Invite one from settings." />}
            columns={[
              { key: 'name', header: 'Name', cell: (row) => row.fullName },
              {
                key: 'designation',
                header: 'Role',
                cell: (row) => (
                  <span className="text-ink-muted">{row.designation ?? 'Trainer'}</span>
                ),
              },
              {
                key: 'specialisations',
                header: 'Specialises in',
                hideOnMobile: true,
                cell: (row) =>
                  row.specialisations.length > 0 ? (
                    <span className="text-sm text-ink-muted">
                      {row.specialisations.join(', ')}
                    </span>
                  ) : (
                    <span className="text-ink-subtle">—</span>
                  ),
              },
              {
                key: 'members',
                header: 'Members',
                align: 'right',
                cell: (row) => (
                  <span className="tabular-nums text-ink">{row.memberCount}</span>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Card title="Everyone" padded={false}>
        <DataTable
          rows={rows}
          rowHref={(row) => `/staff/${row.orgUserId}`}
          empty={
            <EmptyState
              title="Nobody else yet"
              description="Invite a manager, receptionist or trainer from settings."
            />
          }
          columns={[
            { key: 'name', header: 'Name', cell: (row) => row.fullName },
            {
              key: 'role',
              header: 'Role',
              cell: (row) => <span className="text-ink-muted">{row.roleName ?? '—'}</span>,
            },
            {
              key: 'email',
              header: 'Email',
              hideOnMobile: true,
              cell: (row) => <span className="text-ink-muted">{row.email}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => (
                <Badge
                  tone={
                    row.status === 'ACTIVE'
                      ? 'active'
                      : row.status === 'INVITED'
                        ? 'expiring'
                        : 'neutral'
                  }
                >
                  {row.status.toLowerCase()}
                </Badge>
              ),
            },
          ]}
        />
      </Card>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pagination">
          <a
            href={`/staff?page=${page - 1}`}
            className={page > 1 ? 'btn-ghost' : 'btn-ghost pointer-events-none opacity-40'}
          >
            Previous
          </a>
          <span className="text-sm text-ink-muted">
            Page {page} of {totalPages}
          </span>
          <a
            href={`/staff?page=${page + 1}`}
            className={page < totalPages ? 'btn-ghost' : 'btn-ghost pointer-events-none opacity-40'}
          >
            Next
          </a>
        </nav>
      )}
    </div>
  );
}
