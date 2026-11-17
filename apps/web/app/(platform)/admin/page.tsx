import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPlatformStats, listGyms } from '@gym/core';
import { requireSession } from '@/lib/current-session';
import { SignOutButton } from '@/components/sign-out-button';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Platform' };

/**
 * The Super Admin console: the business of selling the software, kept
 * deliberately separate from running a gym.
 *
 * It shows how many gyms there are, what they pay and who is lapsing. It does
 * NOT show anyone's members, payments or messages — reaching those means
 * entering that tenant explicitly, which writes an audit row the gym owner
 * can see.
 */
export default async function PlatformConsolePage() {
  const session = await requireSession('/admin');
  if (!session.user.isPlatformAdmin) notFound();

  const [stats, { rows, total }] = await Promise.all([
    getPlatformStats(session.user.id),
    listGyms(session.user.id, { pageSize: 25 }),
  ]);

  const money = (value: string) =>
    `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const tiles = [
    { label: 'Gyms', value: String(stats.gyms.total), note: `${stats.gyms.trial} on trial` },
    { label: 'Paying', value: String(stats.gyms.active), note: `${stats.gyms.pastDue} past due` },
    { label: 'MRR', value: money(stats.revenue.mrr), note: `${money(stats.revenue.arr)} ARR` },
    {
      label: 'Collected this month',
      value: money(stats.revenue.collectedThisMonth),
      note: `${money(stats.revenue.outstanding)} outstanding`,
    },
    {
      label: 'New this month',
      value: String(stats.growth.newThisMonth),
      note: `${stats.growth.churnedThisMonth} churned`,
    },
    {
      label: 'Suspended',
      value: String(stats.gyms.suspended),
      note: 'Data retained, access closed',
    },
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-control bg-ink text-sm font-semibold text-surface">
              P
            </span>
            <span className="text-base font-semibold text-ink">Platform</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-muted">{session.user.email}</span>
            <div className="w-28">
              <SignOutButton />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 p-4 lg:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Platform overview</h1>
          <p className="mt-1 text-base text-ink-muted">
            Every figure below is counted from the platform ledger, which is kept separate from
            each gym&rsquo;s own revenue.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.label} className="card p-5">
              <p className="text-sm font-medium text-ink-muted">{tile.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-ink">
                {tile.value}
              </p>
              <p className="mt-1 text-sm text-ink-subtle">{tile.note}</p>
            </div>
          ))}
        </div>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-lg font-semibold text-ink">Gyms</h2>
            <span className="text-sm text-ink-muted">{total} total</span>
          </div>

          <table className="w-full text-left">
            <thead className="border-b border-line bg-surface-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                  Gym
                </th>
                <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                  Plan
                </th>
                <th
                  scope="col"
                  className="hidden px-4 py-2.5 text-sm font-semibold text-ink-muted sm:table-cell"
                >
                  Members
                </th>
                <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((gym) => (
                <tr key={gym.id}>
                  <td className="px-4 py-3">
                    <p className="text-base font-medium text-ink">{gym.name}</p>
                    <p className="text-sm text-ink-muted">{gym.ownerEmail ?? gym.slug}</p>
                  </td>
                  <td className="px-4 py-3 text-base text-ink">{gym.planName ?? '—'}</td>
                  <td className="hidden px-4 py-3 text-base tabular-nums text-ink sm:table-cell">
                    {gym.memberCount}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                        gym.status === 'ACTIVE'
                          ? 'bg-accent-soft text-accent'
                          : gym.status === 'SUSPENDED'
                            ? 'bg-danger/10 text-danger'
                            : 'bg-surface-muted text-ink-muted'
                      }`}
                    >
                      {gym.subscriptionStatus ?? gym.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows.length === 0 && (
            <p className="px-4 py-10 text-center text-base text-ink-muted">No gyms yet.</p>
          )}
        </section>

        <p className="text-sm text-ink-subtle">
          Suspending a gym closes access and keeps its data. The owner can still export
          everything, and nothing is deleted without an explicit request.
        </p>
      </main>
    </div>
  );
}
