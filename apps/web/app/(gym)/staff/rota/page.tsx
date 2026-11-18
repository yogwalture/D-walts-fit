import type { Metadata } from 'next';
import Link from 'next/link';
import { staffDay, listLeave, listShifts, businessDayIso } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { RotaControls, MarkRow } from './controls';

export const metadata: Metadata = { title: 'Rota' };
export const dynamic = 'force-dynamic';

const clock = (value: string | null) =>
  value
    ? new Date(value).toLocaleTimeString('en-IN', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : '—';

const hours = (minutes: number | null) => {
  if (minutes === null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const TONES: Record<string, 'active' | 'expiring' | 'expired' | 'frozen' | 'neutral'> = {
  PRESENT: 'active',
  HALF_DAY: 'expiring',
  ABSENT: 'expired',
  ON_LEAVE: 'frozen',
  WEEKLY_OFF: 'neutral',
  HOLIDAY: 'neutral',
};

/**
 * Who is in today.
 *
 * Everybody on the team appears, not only those who turned up: at ten in the
 * morning the question a manager has is who has *not* arrived, and a list of
 * people who are present cannot answer it.
 */
export default async function RotaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/staff/rota');

  const params = await searchParams;
  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const date = one('date') ?? businessDayIso();

  const canMark = holds(session, 'staff.attendance.manage');
  const canRota = holds(session, 'staff.shift.manage');
  const canApprove = holds(session, 'staff.leave.approve');

  const [day, pending, shifts] = await Promise.all([
    staffDay(ctx, actor.permissions, { date }),
    holds(session, 'staff.leave.read')
      ? listLeave(ctx, actor.permissions, { status: 'REQUESTED', limit: 20 })
      : Promise.resolve([]),
    canRota ? listShifts(ctx, actor.permissions) : Promise.resolve([]),
  ]);

  const present = day.rows.filter((r) => r.status === 'PRESENT').length;
  const away = day.rows.filter((r) => r.status === 'ABSENT' || r.status === 'ON_LEAVE').length;
  const unmarked = day.rows.filter((r) => r.status === null).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Rota"
        subtitle={`${day.rows.length} on the team`}
        action={
          <Link href="/staff" className="btn-secondary">
            Team
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="In today" value={present} tone="good" />
        <StatTile label="Away" value={away} tone={away > 0 ? 'warn' : 'default'} />
        <StatTile
          label="Not marked"
          value={unmarked}
          tone={unmarked > 0 ? 'warn' : 'good'}
          hint="Nobody has said either way"
        />
        <StatTile
          label="Leave to decide"
          value={pending.length}
          tone={pending.length > 0 ? 'warn' : 'good'}
        />
      </div>

      <RotaControls
        date={date}
        canMark={canMark}
        canRota={canRota}
        canApprove={canApprove}
        staff={day.rows.map((row) => ({ id: row.orgUserId, name: row.fullName }))}
        pending={pending.map((leave) => ({
          id: leave.id,
          fullName: leave.fullName,
          leaveType: leave.leaveType,
          fromDate: leave.fromDate,
          toDate: leave.toDate,
          days: leave.days,
          reason: leave.reason,
        }))}
        shifts={shifts.map((shift) => ({
          id: shift.id,
          fullName: shift.fullName,
          weekday: shift.weekday,
          shiftDate: shift.shiftDate,
          startTime: shift.startTime,
          endTime: shift.endTime,
        }))}
      />

      <Card title="Today" description={date} padded={false}>
        {day.rows.length === 0 ? (
          <EmptyState title="Nobody on the team yet" description="Invite your staff first." />
        ) : (
          <ul className="divide-y divide-line">
            {day.rows.map((row) => (
              <li
                key={row.orgUserId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium text-ink">{row.fullName}</p>
                  <p className="truncate text-sm text-ink-muted">
                    {row.roleName}
                    {row.shift ? ` · rota ${row.shift.startTime}–${row.shift.endTime}` : ''}
                    {row.notes ? ` · ${row.notes}` : ''}
                  </p>
                </div>

                <span className="w-40 text-sm text-ink-muted">
                  {clock(row.checkedInAt)} – {clock(row.checkedOutAt)}
                </span>

                <span className="w-16 text-right text-sm text-ink-muted">
                  {hours(row.workedMinutes)}
                </span>

                {row.status ? (
                  <Badge tone={TONES[row.status] ?? 'neutral'}>
                    {row.status.toLowerCase().replace('_', ' ')}
                  </Badge>
                ) : (
                  <Badge tone="neutral">not marked</Badge>
                )}

                {canMark && row.status !== 'ON_LEAVE' && (
                  <MarkRow orgUserId={row.orgUserId} date={date} marked={row.status} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
