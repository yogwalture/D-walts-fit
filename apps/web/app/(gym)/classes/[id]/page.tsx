import type { Metadata } from 'next';
import Link from 'next/link';
import { getClass, listMembers } from '@gym/core';
import { requireActor, holds, planLock } from '@/lib/current-session';
import { FeatureLocked } from '@/components/plan-gate';
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { BookPanel, MarkPresent, RemoveBooking, CancelClassPanel } from './register-panel';

export const metadata: Metadata = { title: 'Class' };
export const dynamic = 'force-dynamic';

const time = (value: string) =>
  new Date(value).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

const dayOf = (value: string) =>
  new Date(value).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

/**
 * One class: who is in it, who is waiting, and who turned up.
 *
 * The register is the working part. A trainer with a phone marks people
 * present as they walk in, and that also counts as their gym visit for the
 * day — otherwise a member who only ever comes to the 7am class looks like
 * someone who never attends.
 */
export default async function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, actor, ctx } = await requireActor('/classes/schedule');

  const locked = planLock(session, 'classes.class.read');
  if (locked) {
    return (
      <FeatureLocked
        feature={locked}
        title="Classes"
        blurb="A timetable with capacity and a waitlist that moves on its own when somebody cancels."
      />
    );
  }

  const { id } = await params;
  const detail = await getClass(ctx, actor.permissions, id);

  const canBook = holds(session, 'classes.booking.manage');
  const canManage = holds(session, 'classes.class.manage');

  // The booking picker needs members to choose from. Capped, and searched
  // client-side within that page of names — a gym with four thousand members
  // should not ship all of them to a dropdown.
  const members = canBook
    ? await listMembers(ctx, actor.permissions, { page: 1, pageSize: 100, filter: 'active' })
    : { rows: [], total: 0 };

  const booked = detail.roster.filter((r) => r.status === 'BOOKED' || r.status === 'ATTENDED' || r.status === 'NO_SHOW');
  const waiting = detail.roster.filter((r) => r.status === 'WAITLISTED');
  const present = detail.roster.filter((r) => r.status === 'ATTENDED').length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={detail.title ?? detail.className}
        subtitle={`${dayOf(detail.startsAt)} · ${time(detail.startsAt)} to ${time(detail.endsAt)}`}
        action={
          <Link href="/classes/schedule" className="btn-secondary">
            Back to the timetable
          </Link>
        }
      />

      {detail.status === 'CANCELLED' && (
        <div
          role="alert"
          className="rounded-card border border-danger/20 bg-danger/5 px-4 py-3 text-base text-ink"
        >
          This class was cancelled{detail.cancelReason ? ` — ${detail.cancelReason}` : ''}. Its
          bookings were cancelled with it.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Booked" value={detail.bookedCount} hint={`of ${detail.capacity}`} />
        <StatTile
          label="Places left"
          value={detail.placesLeft}
          tone={detail.placesLeft === 0 ? 'warn' : 'good'}
        />
        <StatTile
          label="Waiting"
          value={detail.waitlistCount}
          tone={detail.waitlistCount > 0 ? 'warn' : 'good'}
          hint="Promoted automatically"
        />
        <StatTile label="Turned up" value={present} hint="Marked present" />
      </div>

      <Card title="Details">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Class" value={detail.className} />
          <Detail label="Trainer" value={detail.trainerName ?? 'Not assigned'} />
          <Detail label="Room" value={detail.room ?? '—'} />
          <Detail label="Branch" value={detail.branchName ?? 'All branches'} />
          <Detail label="Repeats" value={detail.repeats ? 'Part of a weekly series' : 'One-off'} />
          <Detail label="Notes" value={detail.notes ?? '—'} />
        </dl>
      </Card>

      {detail.status !== 'CANCELLED' && (canBook || canManage) && (
        <div className="flex flex-wrap gap-2">
          {canBook && (
            <BookPanel
              classId={detail.id}
              placesLeft={detail.placesLeft}
              alreadyOn={detail.roster.map((r) => r.memberId)}
              members={members.rows.map((row) => ({
                id: row.id,
                name: row.name,
                memberCode: row.memberCode,
                phone: row.phone,
              }))}
            />
          )}
          {canManage && (
            <CancelClassPanel classId={detail.id} repeats={detail.repeats} />
          )}
        </div>
      )}

      <Card title="The register" description={`${booked.length} booked in`} padded={false}>
        {booked.length === 0 ? (
          <EmptyState
            title="Nobody booked in yet"
            description="Book a member in and they appear here, ready to be marked present."
          />
        ) : (
          <ul className="divide-y divide-line">
            {booked.map((entry) => (
              <li key={entry.bookingId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-ink">{entry.memberName}</p>
                  <p className="text-sm text-ink-muted">
                    {entry.memberCode} · {entry.phone}
                  </p>
                </div>
                {entry.status === 'ATTENDED' && <Badge tone="active">Present</Badge>}
                {entry.status === 'NO_SHOW' && <Badge tone="expired">Did not come</Badge>}
                {entry.status === 'BOOKED' && canBook && detail.status !== 'CANCELLED' && (
                  <MarkPresent bookingId={entry.bookingId} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {waiting.length > 0 && (
        <Card
          title="Waiting"
          description="The first on this list moves in automatically when somebody cancels"
          padded={false}
        >
          <ul className="divide-y divide-line">
            {waiting.map((entry) => (
              <li key={entry.bookingId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="w-7 shrink-0 text-base font-semibold text-ink-subtle">
                  {entry.waitlistPosition}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-ink">{entry.memberName}</p>
                  <p className="text-sm text-ink-muted">
                    {entry.memberCode} · {entry.phone}
                  </p>
                </div>
                {canBook && <RemoveBooking bookingId={entry.bookingId} />}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-ink-subtle">{label}</dt>
      <dd className="text-base text-ink">{value}</dd>
    </div>
  );
}
