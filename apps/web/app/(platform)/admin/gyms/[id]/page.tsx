import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getGymDetail, AppError } from '@gym/core';
import { requireSession } from '@/lib/current-session';
import { GymActions } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Gym' };

/**
 * One gym, as the business sees it.
 *
 * Deliberately commercial: what they pay, what they use against their plan,
 * what they owe us. There is no member here, no payment of theirs and no
 * message — reading those means entering their gym, which writes a row they
 * can see in their own audit log.
 */
export default async function PlatformGymPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession(`/admin/gyms/${id}`);
  if (!session.user.isPlatformAdmin) notFound();

  const gym = await getGymDetail(session.user.id, id).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  });

  const money = (value: string) =>
    `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const limit = (used: number, agreed: number | null | undefined) =>
    agreed === null ? `${used} of unlimited` : `${used} of ${agreed ?? '—'}`;

  const overrides = gym.subscription.limitOverrides ?? {};
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 lg:px-6">
          <Link href="/admin" className="text-sm text-ink-muted hover:underline">
            &larr; Platform
          </Link>
          <span className="truncate text-base font-semibold text-ink">{gym.name}</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 p-4 lg:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{gym.name}</h1>
            <p className="mt-1 text-base text-ink-muted">
              {gym.slug}
              {gym.city ? ` · ${gym.city}` : ''} · with us since {gym.createdAt}
            </p>
          </div>
          <div className="text-right text-sm">
            {gym.ownerEmail && (
              <a href={`mailto:${gym.ownerEmail}`} className="block text-accent hover:underline">
                {gym.ownerEmail}
              </a>
            )}
            {gym.ownerPhone && (
              <a href={`tel:${gym.ownerPhone}`} className="block text-accent hover:underline">
                {gym.ownerPhone}
              </a>
            )}
          </div>
        </div>

        {gym.subscription.isReadOnly && (
          <div className="rounded-card border border-danger/30 bg-danger/5 px-4 py-3 text-base text-ink">
            Read-only. They can still see and export everything they have — nothing of theirs
            has been deleted.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Plan"
            value={gym.subscription.planName}
            note={`${money(gym.subscription.monthlyPrice)} a month · ${gym.subscription.billingCycle.toLowerCase()}`}
          />
          <Tile
            label="Status"
            value={gym.subscription.status}
            note={
              gym.subscription.trialEndsAt
                ? `Trial ends ${gym.subscription.trialEndsAt}`
                : gym.subscription.graceUntil
                  ? `Grace until ${gym.subscription.graceUntil}`
                  : `Renews ${gym.subscription.currentPeriodEnd}`
            }
          />
          <Tile
            label="Paid us to date"
            value={money(gym.lifetimeValue)}
            note={`${gym.invoices.length} invoice${gym.invoices.length === 1 ? '' : 's'}`}
          />
          <Tile
            label="Members"
            value={String(gym.usage.members)}
            note={limit(gym.usage.members, overrides.maxMembers)}
          />
        </div>

        <section className="card p-5">
          <h2 className="text-lg font-semibold text-ink">Using their plan</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <Usage label="Branches" used={gym.usage.branches} agreed={overrides.maxBranches} />
            <Usage label="Staff" used={gym.usage.staff} agreed={overrides.maxStaff} />
            <Usage label="Classes" used={gym.usage.classes} agreed={undefined} />
          </dl>
          {hasOverrides && (
            <p className="mt-3 text-sm text-ink-muted">
              Limits here were agreed with this gym, outside their plan.
            </p>
          )}
        </section>

        <GymActions
          organizationId={gym.id}
          isTrial={gym.subscription.status === 'TRIAL'}
          overrides={overrides}
        />

        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-lg font-semibold text-ink">What we have invoiced them</h2>
          </div>

          {gym.invoices.length === 0 ? (
            <p className="px-4 py-10 text-center text-base text-ink-muted">
              Nothing invoiced yet.
            </p>
          ) : (
            <table className="w-full text-left">
              <thead className="border-b border-line bg-surface-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                    Invoice
                  </th>
                  <th scope="col" className="hidden px-4 py-2.5 text-sm font-semibold text-ink-muted sm:table-cell">
                    Period
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                    Total
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {gym.invoices.map((invoice) => (
                  <tr key={invoice.code}>
                    <td className="px-4 py-3">
                      <p className="text-base text-ink">{invoice.code}</p>
                      <p className="text-sm text-ink-muted">Issued {invoice.issuedOn}</p>
                    </td>
                    <td className="hidden px-4 py-3 text-base text-ink-muted sm:table-cell">
                      {invoice.period}
                    </td>
                    <td className="px-4 py-3 text-base tabular-nums text-ink">
                      {money(invoice.total)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                          invoice.status === 'PAID'
                            ? 'bg-accent-soft text-accent'
                            : 'bg-warning/10 text-warning'
                        }`}
                      >
                        {invoice.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="text-sm text-ink-subtle">
          This page shows commercial facts and counts. It cannot show this gym&rsquo;s members,
          payments or messages: reaching those writes a row in their own audit log, and they
          can read it.
        </p>
      </main>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card p-5">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-sm text-ink-subtle">{note}</p>
    </div>
  );
}

function Usage({
  label,
  used,
  agreed,
}: {
  label: string;
  used: number;
  agreed: number | null | undefined;
}) {
  return (
    <div>
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-base tabular-nums text-ink">
        {used}
        {agreed === null ? ' of unlimited (agreed)' : agreed ? ` of ${agreed} (agreed)` : ''}
      </dd>
    </div>
  );
}
