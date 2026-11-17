import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { listAssignableRoles, listStaff, resolvePermissions } from '@gym/core';
import { requireSession, holds } from '@/lib/current-session';
import { InviteStaffDialog } from './invite-dialog';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Staff' };

export default async function StaffSettingsPage() {
  const session = await requireSession('/settings/users');
  if (!holds(session, 'org.user.read')) notFound();

  const ctx = { organizationId: session.organization!.id, userId: session.user.id };

  // The page re-derives permissions rather than trusting the client view,
  // because listStaff guards on them and the server is the boundary.
  const permissions = resolvePermissions({
    roleKey: session.role?.key ?? null,
    rolePermissions: Object.entries(session.permissions).map(([permissionKey, scope]) => ({
      permissionKey,
      scope,
    })),
    overrides: [],
    branchIds: session.branchIds,
    planFeatures: [],
    isPlatformAdmin: session.user.isPlatformAdmin,
  });

  const [{ rows, total }, roles] = await Promise.all([
    listStaff(ctx, permissions, { pageSize: 50 }),
    holds(session, 'org.user.invite') ? listAssignableRoles(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Staff</h1>
          <p className="mt-1 text-base text-ink-muted">
            {total} {total === 1 ? 'person' : 'people'} with access to this gym.
          </p>
        </div>
        {holds(session, 'org.user.invite') && <InviteStaffDialog roles={roles} />}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left">
          <thead className="border-b border-line bg-surface-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                Name
              </th>
              <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                Role
              </th>
              <th scope="col" className="hidden px-4 py-2.5 text-sm font-semibold text-ink-muted sm:table-cell">
                Branches
              </th>
              <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.orgUserId}>
                <td className="px-4 py-3">
                  <p className="text-base font-medium text-ink">{row.fullName}</p>
                  <p className="text-sm text-ink-muted">{row.email}</p>
                </td>
                <td className="px-4 py-3 text-base text-ink">{row.roleName}</td>
                <td className="hidden px-4 py-3 text-base text-ink-muted sm:table-cell">
                  {row.branchNames.length > 0 ? row.branchNames.join(', ') : 'All branches'}
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <p className="px-4 py-10 text-center text-base text-ink-muted">
            No staff yet. Invite your first team member.
          </p>
        )}
      </div>

      <p className="text-sm text-ink-subtle">
        Invited people set their own password. Nobody — including you — can see it.
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ACTIVE: 'bg-accent-soft text-accent',
    INVITED: 'bg-surface-muted text-ink-muted',
    SUSPENDED: 'bg-danger/10 text-danger',
  };
  const labels: Record<string, string> = {
    ACTIVE: 'Active',
    INVITED: 'Invited',
    SUSPENDED: 'Suspended',
  };

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
        styles[status] ?? 'bg-surface-muted text-ink-muted'
      }`}
    >
      {labels[status] ?? status}
    </span>
  );
}
