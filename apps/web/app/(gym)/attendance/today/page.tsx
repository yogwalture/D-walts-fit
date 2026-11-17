import type { Metadata } from 'next';
import { peakHours, todaysAttendance } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { Badge, Card, DataTable, EmptyState, PageHeader, StatTile, timeOfDay } from '@/components/ui';
import { PeakHoursChart } from '@/components/charts';
import { CheckInPanel } from './check-in-panel';

export const metadata: Metadata = { title: 'Attendance' };
export const dynamic = 'force-dynamic';

/**
 * Today's attendance, with the check-in box at the top.
 *
 * The check-in box comes first because that is what this screen is for most
 * of the time; the list below is what the receptionist glances at between
 * people.
 */
export default async function AttendancePage() {
  const { session, actor, ctx } = await requireActor('/attendance/today');

  const [visits, hours] = await Promise.all([
    todaysAttendance(ctx, actor.permissions, { limit: 100 }),
    holds(session, 'attendance.report.read')
      ? peakHours(ctx, actor.permissions, {
          fromDate: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
          toDate: new Date().toISOString().slice(0, 10),
        })
      : Promise.resolve([]),
  ]);

  const stillIn = visits.filter((visit) => !visit.checkedOutAt).length;
  const overrides = visits.filter((visit) => visit.wasOverride).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Attendance" subtitle="Today, in the gym's own timezone" />

      {holds(session, 'attendance.checkin.create') && <CheckInPanel />}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="In today" value={visits.length} />
        <StatTile label="Still in" value={stillIn} />
        <StatTile
          label="Overrides"
          value={overrides}
          tone={overrides > 0 ? 'warn' : 'default'}
          hint={overrides > 0 ? 'Each one is audited' : undefined}
        />
      </div>

      <Card title="Today" padded={false}>
        <DataTable
          rows={visits}
          rowHref={(row) => `/members/${row.memberId}`}
          empty={
            <EmptyState
              title="Nobody in yet today"
              description="Scan a member's code above and they will appear here."
            />
          }
          columns={[
            { key: 'name', header: 'Member', cell: (row) => row.name },
            {
              key: 'code',
              header: 'Code',
              hideOnMobile: true,
              cell: (row) => <span className="tabular-nums text-ink-muted">{row.memberCode}</span>,
            },
            {
              key: 'in',
              header: 'In',
              cell: (row) => <span className="tabular-nums">{timeOfDay(row.checkedInAt)}</span>,
            },
            {
              key: 'out',
              header: 'Out',
              cell: (row) => (
                <span className="tabular-nums text-ink-muted">
                  {row.checkedOutAt ? timeOfDay(row.checkedOutAt) : 'Still in'}
                </span>
              ),
            },
            {
              key: 'how',
              header: 'How',
              hideOnMobile: true,
              cell: (row) => (
                <span className="flex items-center gap-2">
                  <span className="text-sm text-ink-muted">
                    {row.method.toLowerCase().replace('_', ' ')}
                  </span>
                  {row.wasOverride && <Badge tone="expiring">override</Badge>}
                </span>
              ),
            },
          ]}
        />
      </Card>

      {hours.length > 0 && hours.some((hour) => hour.visits > 0) && (
        <Card title="Busiest hours" description="Last 30 days — useful for rostering">
          <PeakHoursChart data={hours} />
        </Card>
      )}
    </div>
  );
}
