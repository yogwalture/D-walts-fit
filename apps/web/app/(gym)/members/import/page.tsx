import type { Metadata } from 'next';
import Link from 'next/link';
import { listImports } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { notFound } from 'next/navigation';
import { Card, PageHeader, shortDate } from '@/components/ui';
import { ImportWizard } from './wizard';

export const metadata: Metadata = { title: 'Import members' };
export const dynamic = 'force-dynamic';

/**
 * Bringing an existing gym's member list in.
 *
 * The step that decides whether a gym can switch at all: nobody retypes four
 * hundred members.
 */
export default async function ImportPage() {
  const { session, actor, ctx } = await requireActor('/members/import');
  if (!holds(session, 'members.member.create')) notFound();

  const history = await listImports(ctx, actor.permissions, { limit: 10 });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Import members"
        subtitle="Bring your existing member list across from a spreadsheet."
        action={
          <Link href="/members" className="btn-ghost">
            Back to members
          </Link>
        }
      />

      <ImportWizard />

      {history.length > 0 && (
        <Card title="Previous imports" padded={false}>
          <ul className="divide-y divide-line">
            {history.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-ink">{row.filename}</p>
                  <p className="text-sm text-ink-muted">
                    {shortDate(row.createdAt)} ·{' '}
                    {row.status === 'COMPLETED'
                      ? `${row.createdCount} imported`
                      : row.status.toLowerCase()}
                    {row.invalidRows + row.duplicateRows > 0 &&
                      ` · ${row.invalidRows + row.duplicateRows} not imported`}
                  </p>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-ink-subtle">
                  {row.totalRows} rows
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
