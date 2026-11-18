import type { Metadata } from 'next';
import { memberClassList } from '@gym/core';
import { requireActor } from '@/lib/current-session';
import { memberContextOf } from '@/lib/tenant';
import { Card, EmptyState } from '@/components/ui';
import { ClassRow } from './row';

export const metadata: Metadata = { title: 'Classes' };
export const dynamic = 'force-dynamic';

/**
 * What is on, and where this member stands on each.
 *
 * One list rather than two. "What is on" and "what have I booked" are the
 * same screen in a member's head, and a separate bookings page is where
 * double bookings come from.
 */
export default async function MyClassesPage() {
  const { actor } = await requireActor('/my/classes');
  const classes = await memberClassList(memberContextOf(actor), actor.permissions, { days: 7 });

  const byDay = new Map<string, typeof classes>();
  for (const row of classes) {
    const day = new Date(row.startsAt).toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
    });
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Classes</h1>

      {classes.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing on this week"
            description="When your gym puts classes on the timetable, they appear here."
          />
        </Card>
      ) : (
        [...byDay].map(([day, rows]) => (
          <section key={day}>
            <h2 className="mb-2 px-1 text-sm font-semibold uppercase tracking-wider text-ink-subtle">
              {day}
            </h2>
            <Card padded={false}>
              <ul className="divide-y divide-line">
                {rows.map((row) => (
                  <li key={row.id}>
                    <ClassRow row={row} />
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
    </div>
  );
}
