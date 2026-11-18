import type { Metadata } from 'next';
import Link from 'next/link';
import { getStaffProfile, trainerRoster } from '@gym/core';
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
import { StaffProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Team member' };
export const dynamic = 'force-dynamic';

export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, actor, ctx } = await requireActor('/staff');
  const { id } = await params;

  const profile = await getStaffProfile(ctx, actor.permissions, id);
  const roster =
    profile.memberCount > 0
      ? await trainerRoster(ctx, actor.permissions, id)
      : { trainer: null, members: [] };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={profile.fullName}
        subtitle={[profile.designation ?? profile.roleName, profile.employeeCode]
          .filter(Boolean)
          .join(' · ')}
        action={
          <Link href="/staff" className="btn-ghost">
            Back to team
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Role</p>
          <p className="mt-2 text-lg font-semibold text-ink">{profile.roleName ?? '—'}</p>
          <p className="mt-1">
            <Badge tone={profile.status === 'ACTIVE' ? 'active' : 'neutral'}>
              {profile.status.toLowerCase()}
            </Badge>
          </p>
        </div>

        <div className="card p-5">
          <p className="text-sm font-medium text-ink-muted">Members</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-ink">
            {profile.memberCount}
          </p>
          <p className="mt-1 text-sm text-ink-subtle">Assigned to them</p>
        </div>

        {profile.canSeeSalary ? (
          <div className="card p-5">
            <p className="text-sm font-medium text-ink-muted">Pay</p>
            <p className="mt-2 text-xl font-semibold tabular-nums text-ink">
              {profile.salary?.amount ? rupees(profile.salary.amount) : '—'}
            </p>
            <p className="mt-1 text-sm text-ink-subtle">
              {profile.salary?.cycle ? profile.salary.cycle.toLowerCase() : 'Not recorded'}
            </p>
          </div>
        ) : (
          <div className="card p-5">
            <p className="text-sm font-medium text-ink-muted">Joined</p>
            <p className="mt-2 text-xl font-semibold text-ink">
              {shortDate(profile.joiningDate)}
            </p>
          </div>
        )}
      </div>

      {holds(session, 'staff.profile.update') && (
        <StaffProfileForm
          orgUserId={id}
          canEditSalary={holds(session, 'staff.salary.update')}
          initial={{
            employeeCode: profile.employeeCode ?? '',
            designation: profile.designation ?? '',
            department: profile.department ?? '',
            joiningDate: profile.joiningDate
              ? new Date(profile.joiningDate).toISOString().slice(0, 10)
              : '',
            specialisations: profile.specialisations.join(', '),
            certifications: profile.certifications.join(', '),
            bio: profile.bio ?? '',
            salaryAmount: profile.salary?.amount ?? '',
            salaryCycle: profile.salary?.cycle ?? '',
            bankAccountMasked: profile.salary?.bankAccountMasked ?? '',
            bankIfsc: profile.salary?.bankIfsc ?? '',
            panMasked: profile.salary?.panMasked ?? '',
          }}
        />
      )}

      {roster.members.length > 0 && (
        <Card title="Their members" padded={false}>
          <DataTable
            rows={roster.members}
            rowHref={(row) => `/members/${row.id}`}
            empty={<EmptyState title="No members yet" description="Assign one from a profile." />}
            columns={[
              { key: 'name', header: 'Member', cell: (row) => row.name },
              {
                key: 'code',
                header: 'Code',
                hideOnMobile: true,
                cell: (row) => <span className="tabular-nums text-ink-muted">{row.memberCode}</span>,
              },
              {
                key: 'membership',
                header: 'Membership',
                cell: (row) => {
                  const { tone, label } = membershipTone(row.membershipExpiresAt);
                  return <Badge tone={tone}>{label}</Badge>;
                },
              },
              {
                key: 'lastVisit',
                header: 'Last in',
                cell: (row) => (
                  <span className="text-ink-muted">
                    {row.lastVisitAt ? shortDate(row.lastVisitAt) : 'Never'}
                  </span>
                ),
              },
              {
                key: 'since',
                header: 'Since',
                align: 'right',
                hideOnMobile: true,
                cell: (row) => <span className="text-ink-muted">{shortDate(row.since)}</span>,
              },
            ]}
          />
        </Card>
      )}

      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Email" value={profile.email} />
          <Detail label="Phone" value={profile.phone ?? '—'} />
          <Detail label="Department" value={profile.department ?? '—'} />
          <Detail label="Joined" value={shortDate(profile.joiningDate)} />
          <Detail
            label="Specialises in"
            value={profile.specialisations.join(', ') || '—'}
          />
          <Detail label="Certifications" value={profile.certifications.join(', ') || '—'} />
          <Detail
            label="Branches"
            value={profile.branchNames.join(', ') || 'All branches'}
          />
        </dl>
        {profile.bio && <p className="mt-4 text-base text-ink">{profile.bio}</p>}
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm font-medium text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-base text-ink">{value}</dd>
    </div>
  );
}
