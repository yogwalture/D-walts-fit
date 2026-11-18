import type { Metadata } from 'next';
import { memberVisits } from '@gym/core';
import { requireActor } from '@/lib/current-session';
import { memberContextOf } from '@/lib/tenant';
import { Card, EmptyState } from '@/components/ui';

export const metadata: Metadata = { title: 'Visits' };
export const dynamic = 'force-dynamic';

const day = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

const time = (value: string) =>
  new Date(value).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

export default async function MyVisitsPage() {
  const { actor } = await requireActor('/my/visits');
  const { rows, streak } = await memberVisits(memberContextOf(actor), actor.permissions, {
    limit: 90,
  });

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Visits</h1>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No visits yet"
            description="Check in at the gym and they appear here."
          />
        </Card>
      ) : (
        <>
          <Card>
            <p className="text-sm text-ink-subtle">Current streak</p>
            <p className="text-3xl font-semibold text-ink">
              {streak} {streak === 1 ? 'day' : 'days'}
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              Counted from your last visit, so looking at this page before training does not
              break it.
            </p>
          </Card>

          <Card padded={false}>
            <ul className="divide-y divide-line">
              {rows.map((visit) => (
                <li key={visit.date} className="flex items-center justify-between px-4 py-3">
                  <span className="text-base text-ink">{day(visit.date)}</span>
                  <span className="text-sm text-ink-muted">{time(visit.checkedInAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
