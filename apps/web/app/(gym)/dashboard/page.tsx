import type { Metadata } from 'next';
import { withTenant } from '@gym/db';
import { requireSession, holds } from '@/lib/current-session';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

/**
 * The dashboard.
 *
 * Every figure here is counted from the database inside the tenant's own
 * context. Nothing is fabricated, and an empty gym shows zeros and an
 * onboarding prompt rather than invented demo numbers.
 *
 * Phase 2 adds the eight charts and the configurable date filter; this is
 * the Phase 1 shell that proves the data path end to end.
 */
export default async function DashboardPage() {
  const session = await requireSession('/dashboard');
  const organizationId = session.organization!.id;

  const today = new Date();
  const startOfToday = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const inSevenDays = new Date(startOfToday.getTime() + 7 * 864e5);

  const stats = await withTenant(
    { organizationId, userId: session.user.id, branchIds: session.branchIds },
    async (tx) => {
      const [totalMembers, activeMembers, expiringSoon, todayAttendance, openLeads] =
        await Promise.all([
          tx.member.count({ where: { deletedAt: null } }),
          tx.member.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
          tx.member.count({
            where: {
              deletedAt: null,
              status: 'ACTIVE',
              membershipExpiresAt: { gte: startOfToday, lte: inSevenDays },
            },
          }),
          tx.attendance.count({ where: { attendanceDate: startOfToday } }),
          tx.lead.count({
            where: { deletedAt: null, status: { notIn: ['CONVERTED', 'LOST'] } },
          }),
        ]);

      return { totalMembers, activeMembers, expiringSoon, todayAttendance, openLeads };
    },
  );

  const tiles = [
    { label: 'Total members', value: stats.totalMembers, permission: 'members.member.read' },
    { label: 'Active memberships', value: stats.activeMembers, permission: 'memberships.subscription.read' },
    { label: 'Expiring in 7 days', value: stats.expiringSoon, permission: 'memberships.subscription.read' },
    { label: "Today's attendance", value: stats.todayAttendance, permission: 'attendance.record.read' },
    { label: 'Open enquiries', value: stats.openLeads, permission: 'crm.lead.read' },
  ].filter((tile) => holds(session, tile.permission));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {greeting()}, {session.user.fullName.split(' ')[0]}
        </h1>
        <p className="mt-1 text-base text-ink-muted">
          {session.organization!.name} · {session.role?.name}
        </p>
      </div>

      {stats.totalMembers === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.label} className="card p-5">
              <p className="text-sm font-medium text-ink-muted">{tile.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-ink">
                {tile.value.toLocaleString('en-IN')}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="card p-5">
        <h2 className="text-lg font-semibold text-ink">Phase 1</h2>
        <p className="mt-1 text-base text-ink-muted">
          Foundation: authentication, the permission engine and tenant isolation are live. The
          figures above are counted from your own records — Phase 2 adds member management,
          memberships, attendance and billing.
        </p>
      </div>
    </div>
  );
}

function greeting(): string {
  // The gym's timezone, not the server's. Hostinger runs UTC.
  const hour = Number(
    new Intl.DateTimeFormat('en-IN', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
        <span aria-hidden className="text-lg font-semibold">
          +
        </span>
      </div>
      <h2 className="text-lg font-semibold text-ink">No members yet</h2>
      <p className="mt-1 max-w-sm text-base text-ink-muted">
        Once you register your first member, this dashboard fills with your real numbers. Nothing
        here is sample data.
      </p>
    </div>
  );
}
