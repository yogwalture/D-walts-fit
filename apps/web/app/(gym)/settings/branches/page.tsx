import type { Metadata } from 'next';
import { listBranches } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { Badge, Card, PageHeader } from '@/components/ui';
import { BranchPanel } from './panel';

export const metadata: Metadata = { title: 'Branches' };
export const dynamic = 'force-dynamic';

/**
 * The gym's branches.
 *
 * How many a gym may have is a plan question, so adding one past the limit
 * is refused by the server with the plan named — the interface does not try
 * to guess, it asks and reports what it is told.
 */
export default async function BranchesPage() {
  const { session, actor, ctx } = await requireActor('/settings/branches');

  const branches = await listBranches(ctx, actor.permissions);
  const canAdd = holds(session, 'org.branch.create');

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Branches"
        subtitle={branches.length === 1 ? 'One branch' : `${branches.length} branches`}
      />

      {canAdd && <BranchPanel />}

      <Card padded={false}>
        <ul className="divide-y divide-line">
          {branches.map((branch) => (
            <li key={branch.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium text-ink">
                  {branch.name}
                  {branch.isPrimary && (
                    <span className="ml-2 text-sm font-normal text-ink-subtle">main</span>
                  )}
                </p>
                <p className="truncate text-sm text-ink-muted">
                  {[branch.code, branch.city].filter(Boolean).join(' · ') || 'No address yet'}
                </p>
              </div>
              <span className="text-sm text-ink-muted">
                {branch.memberCount} {branch.memberCount === 1 ? 'member' : 'members'}
              </span>
              {branch.isPrimary && <Badge tone="active">Main</Badge>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
