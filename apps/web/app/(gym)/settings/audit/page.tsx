import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { listAudit } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Activity log' };

/**
 * The gym's own record of who did what — including us.
 *
 * Every claim elsewhere in this software that platform support "writes a row
 * the gym owner can see" is settled here. If this page did not exist, that
 * sentence would be a comment in a file the owner cannot read.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { session, actor, ctx } = await requireActor('/settings/audit');
  if (!holds(session, 'org.audit.read')) notFound();

  const { view } = await searchParams;
  const platformOnly = view === 'platform';

  const { rows, total } = await listAudit(ctx, actor.permissions, {
    pageSize: 100,
    platformOnly,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Activity log</h1>
        <p className="mt-1 text-base text-ink-muted">
          Who changed what in this gym, and when. Including anything the people who make this
          software did on your account.
        </p>
      </div>

      <div className="flex gap-2">
        <a
          href="/settings/audit"
          className={platformOnly ? 'btn-secondary' : 'btn-primary'}
          aria-current={platformOnly ? undefined : 'page'}
        >
          Everything
        </a>
        <a
          href="/settings/audit?view=platform"
          className={platformOnly ? 'btn-primary' : 'btn-secondary'}
          aria-current={platformOnly ? 'page' : undefined}
        >
          Only the software company
        </a>
      </div>

      {platformOnly && (
        <div className="rounded-card border border-line bg-surface-muted px-4 py-3 text-base text-ink-muted">
          Support cannot read anything in your gym without leaving a row here first. An empty
          list means nobody has been in.
        </div>
      )}

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold text-ink">
            {platformOnly ? 'Support activity' : 'Recent activity'}
          </h2>
          <span className="text-sm text-ink-muted">
            {total} {total === 1 ? 'entry' : 'entries'}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-base text-ink-muted">
            {platformOnly
              ? 'Nobody from the software company has acted on your account.'
              : 'Nothing recorded yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((entry) => (
              <li key={entry.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-base text-ink">
                    <span className="font-medium">{entry.actor}</span>{' '}
                    {entry.summary ?? entry.action}
                  </p>
                  <time dateTime={entry.at} className="shrink-0 text-sm text-ink-subtle">
                    {new Date(entry.at).toLocaleString('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </div>
                <p className="mt-0.5 text-sm text-ink-subtle">
                  {entry.action}
                  {entry.isPlatformActor && (
                    <span className="ml-2 rounded-full bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                      Software company
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-sm text-ink-subtle">
        Entries cannot be edited or removed, by you or by us. Passwords, keys and payment
        credentials are never written here.
      </p>
    </div>
  );
}
