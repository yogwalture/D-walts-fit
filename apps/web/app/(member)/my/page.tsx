import type { Metadata } from 'next';
import Link from 'next/link';
import { memberHome } from '@gym/core';
import { requireActor } from '@/lib/current-session';
import { memberContextOf } from '@/lib/tenant';
import { Badge, Card, rupees } from '@/components/ui';
import { CheckInPanel } from './check-in';
import { MyDataButton } from './my-data';

export const metadata: Metadata = { title: 'My gym' };
export const dynamic = 'force-dynamic';

const when = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * A member's own page.
 *
 * Led by the two things they came to find out: how long is left, and do
 * they owe anything. Everything else is below the fold on purpose.
 */
export default async function MyPage() {
  const { actor } = await requireActor('/my');
  const home = await memberHome(memberContextOf(actor), actor.permissions);

  const days = home.membership?.daysLeft ?? 0;
  const expiringSoon = home.membership !== null && days <= 7;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {home.member.name.split(' ')[0]}
        </h1>
        <p className="text-base text-ink-muted">
          {home.member.memberCode}
          {home.member.branchName ? ` · ${home.member.branchName}` : ''}
        </p>
      </div>

      {home.membership ? (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-ink-subtle">Your membership</p>
              <p className="text-xl font-semibold text-ink">{home.membership.planName}</p>
            </div>
            <Badge
              tone={
                home.membership.isFrozen
                  ? 'frozen'
                  : days < 0
                    ? 'expired'
                    : expiringSoon
                      ? 'expiring'
                      : 'active'
              }
            >
              {home.membership.isFrozen
                ? 'Frozen'
                : days < 0
                  ? 'Ended'
                  : `${days} ${days === 1 ? 'day' : 'days'} left`}
            </Badge>
          </div>

          <p className="mt-3 text-base text-ink-muted">
            {days < 0
              ? `Ended on ${home.membership.endDate}. Speak to the desk to start again.`
              : `Runs to ${home.membership.endDate}.`}
            {home.membership.sessionsLeft !== null &&
              ` ${home.membership.sessionsLeft} sessions left.`}
          </p>
        </Card>
      ) : (
        <Card>
          <p className="text-base text-ink">You have no active membership.</p>
          <p className="mt-1 text-sm text-ink-muted">
            Speak to the front desk to start one — they can set it up in a minute.
          </p>
        </Card>
      )}

      {Number(home.dues.amount) > 0 && (
        <Card>
          <p className="text-sm text-ink-subtle">Outstanding</p>
          <p className="text-xl font-semibold text-ink">{rupees(home.dues.amount)}</p>
          <p className="mt-1 text-sm text-ink-muted">
            Across {home.dues.invoices} {home.dues.invoices === 1 ? 'invoice' : 'invoices'}. Pay at
            the desk, or ask them to send a payment link.
          </p>
          <Link href="/my/payments" className="mt-3 inline-flex btn-secondary">
            See what is owed
          </Link>
        </Card>
      )}

      <CheckInPanel />

      <Card title="Your visits">
        <div className="flex gap-6">
          <div>
            <p className="text-2xl font-semibold text-ink">{home.visits.thisMonth}</p>
            <p className="text-sm text-ink-muted">this month</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-ink">{home.visits.total}</p>
            <p className="text-sm text-ink-muted">in total</p>
          </div>
          <div className="min-w-0">
            <p className="truncate text-2xl font-semibold text-ink">
              {home.visits.lastVisit ?? '—'}
            </p>
            <p className="text-sm text-ink-muted">last visit</p>
          </div>
        </div>
      </Card>

      <Card
        title="Coming up"
        action={
          <Link href="/my/classes" className="text-base text-accent hover:underline">
            All classes
          </Link>
        }
      >
        {home.upcomingClasses.length === 0 ? (
          <p className="text-base text-ink-muted">
            Nothing booked. Have a look at what is on this week.
          </p>
        ) : (
          <ul className="space-y-2">
            {home.upcomingClasses.map((booking) => (
              <li key={booking.bookingId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base text-ink">{booking.className}</p>
                  <p className="text-sm text-ink-muted">{when(booking.startsAt)}</p>
                </div>
                {booking.status === 'WAITLISTED' && (
                  <Badge tone="expiring">Waiting · {booking.waitlistPosition}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Your data">
        <MyDataButton />
      </Card>
    </div>
  );
}
