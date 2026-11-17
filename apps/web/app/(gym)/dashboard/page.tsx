import type { Metadata } from 'next';
import Link from 'next/link';
import {
  businessDayIso,
  getDashboardSummary,
  getCharts,
  getActionLists,
  peakHours,
  type DateRangeKey,
} from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import {
  Card,
  EmptyState,
  PageHeader,
  StatTile,
  rupees,
  shortDate,
  spoken,
} from '@/components/ui';
import { CountChart, MixChart, PeakHoursChart, RevenueChart } from '@/components/charts';
import { RangePicker } from './range-picker';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

const RANGES: DateRangeKey[] = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'thisFinancialYear',
];

/**
 * The dashboard.
 *
 * Every figure is counted from this gym's own records, inside its own tenant
 * context. Nothing is fabricated: an empty gym shows zeros and a prompt, not
 * invented demo numbers.
 *
 * The three lists at the bottom are the point of the page. Numbers tell an
 * owner how the month went; the lists tell them who to ring this afternoon.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { session, actor, ctx } = await requireActor('/dashboard');
  const params = await searchParams;

  const requested = typeof params.range === 'string' ? params.range : 'last30';
  const range = (RANGES as string[]).includes(requested)
    ? (requested as DateRangeKey)
    : 'last30';

  const canSeeMoney = holds(session, 'finance.payment.read');

  const [summary, charts, lists, hours] = await Promise.all([
    getDashboardSummary(ctx, actor.permissions, { range }),
    getCharts(ctx, actor.permissions, { months: 6 }),
    getActionLists(ctx, actor.permissions, { limit: 8 }),
    holds(session, 'attendance.report.read')
      ? peakHours(ctx, actor.permissions, {
          fromDate: summaryWindowStart(),
          toDate: businessDayIso(),
        })
      : Promise.resolve([]),
  ]);

  if (summary.members.total === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader
          title={`${greeting()}, ${session.user.fullName.split(' ')[0]}`}
          subtitle={`${session.organization!.name} · ${session.role?.name}`}
        />
        <Card padded={false}>
          <EmptyState
            title="No members yet"
            description="Register your first member and this dashboard fills with your real numbers. Nothing here is sample data."
            action={
              holds(session, 'members.member.create') ? (
                <Link href="/members/new" className="btn-primary">
                  Register a member
                </Link>
              ) : undefined
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={`${greeting()}, ${session.user.fullName.split(' ')[0]}`}
        subtitle={`${session.organization!.name} · ${summary.range.label}`}
        action={<RangePicker current={range} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Active members"
          value={summary.members.active}
          hint={`${summary.members.total.toLocaleString('en-IN')} on the books`}
        />
        <StatTile
          label="Expiring in 7 days"
          value={summary.members.expiringIn7Days}
          tone={summary.members.expiringIn7Days > 0 ? 'warn' : 'default'}
          hint="Worth a call"
        />
        <StatTile
          label="In today"
          value={summary.attendance.today}
          hint={`${summary.attendance.averagePerDay}/day average`}
        />
        <StatTile
          label="Joined"
          value={summary.members.newInRange}
          hint={summary.range.label.toLowerCase()}
        />
      </div>

      {canSeeMoney && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Collected"
            value={rupees(summary.money.collectedInRange)}
            tone="good"
            hint={summary.range.label.toLowerCase()}
          />
          <StatTile
            label="Outstanding"
            value={rupees(summary.money.outstanding)}
            tone={Number(summary.money.outstanding) > 0 ? 'warn' : 'default'}
            hint="Across all members"
          />
          <StatTile label="Expenses" value={rupees(summary.money.expensesInRange)} />
          <StatTile
            label="Net"
            value={rupees(summary.money.netInRange)}
            tone={Number(summary.money.netInRange) >= 0 ? 'good' : 'warn'}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {canSeeMoney && (
          <Card title="Collected by month" description="Last six months">
            <RevenueChart data={charts.revenue} />
          </Card>
        )}

        <Card title="Visits by month">
          <CountChart data={charts.attendance} label="Visits" color="#0891b2" />
        </Card>

        <Card title="New members by month">
          <CountChart data={charts.joins} label="Joined" color="#7c3aed" />
        </Card>

        {hours.length > 0 && (
          <Card title="Busiest hours" description="Last 30 days">
            <PeakHoursChart data={hours} />
          </Card>
        )}

        {charts.planMix.length > 0 && (
          <Card title="Which plans members are on">
            <MixChart data={charts.planMix} />
          </Card>
        )}

        {canSeeMoney && charts.collectionByMethod.length > 0 && (
          <Card title="How members pay">
            <MixChart
              data={charts.collectionByMethod.map((slice) => ({
                label: spoken(slice.label),
                value: slice.value,
              }))}
            />
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Expiring soon"
          description="Renew before they lapse"
          padded={false}
        >
          <CallList
            rows={lists.expiringSoon.map((row) => ({
              id: row.id,
              name: row.name,
              phone: row.phone,
              detail: shortDate(row.expiresAt),
            }))}
            empty="Nobody is about to expire."
          />
        </Card>

        {canSeeMoney && (
          <Card title="Money owed" description="Follow up" padded={false}>
            <CallList
              rows={lists.overdue.map((row) => ({
                id: row.id,
                name: row.name,
                phone: row.phone,
                detail: rupees(row.amount),
              }))}
              empty="Nothing outstanding."
            />
          </Card>
        )}

        <Card
          title="Gone quiet"
          description="No visit in 30 days"
          padded={false}
        >
          <CallList
            rows={lists.goneQuiet.map((row) => ({
              id: row.id,
              name: row.name,
              phone: row.phone,
              detail: row.lastVisitAt ? shortDate(row.lastVisitAt) : 'Never',
            }))}
            empty="Everyone has been in recently."
          />
        </Card>
      </div>
    </div>
  );
}

function CallList({
  rows,
  empty,
}: {
  rows: Array<{ id: string; name: string; phone: string; detail: string }>;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="px-5 py-6 text-base text-ink-muted">{empty}</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
          <div className="min-w-0">
            <Link
              href={`/members/${row.id}`}
              className="block truncate text-base font-medium text-accent hover:underline"
            >
              {row.name}
            </Link>
            <a
              href={`tel:+91${row.phone}`}
              className="text-sm text-ink-muted tabular-nums hover:underline"
            >
              {row.phone}
            </a>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-ink-muted">{row.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** 30 days back, in the gym's own day rather than the server's. */
function summaryWindowStart(): string {
  return businessDayIso('Asia/Kolkata', new Date(Date.now() - 30 * 86_400_000));
}

function greeting(): string {
  // The gym's timezone, not the server's. Hostinger runs UTC.
  const hour = Number(
    new Intl.DateTimeFormat('en-IN', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
