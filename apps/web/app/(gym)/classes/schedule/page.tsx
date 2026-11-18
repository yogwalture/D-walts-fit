import type { Metadata } from 'next';
import { listClasses, listClassTypes, listTrainers, businessDayIso } from '@gym/core';
import { requireActor, holds, planLock } from '@/lib/current-session';
import { FeatureLocked } from '@/components/plan-gate';
import { Badge, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { DayPicker } from './day-picker';
import { SchedulePanel } from './schedule-panel';
import { ClassList } from './class-list';

export const metadata: Metadata = { title: 'Classes' };
export const dynamic = 'force-dynamic';

/**
 * The timetable, one day at a time.
 *
 * A day rather than a month, because the question a gym asks at the desk is
 * "what is on today and is there room in it" — not "show me October". The
 * places left on each class is the number that matters, so it is what the
 * row leads with.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const params = await searchParams;
  const one = (key: string): string | undefined =>
    typeof params[key] === 'string' ? (params[key] as string) : undefined;

  const day = one('day') ?? businessDayIso();

  const canManage = holds(session, 'classes.class.manage');

  const [timetable, types, trainers] = await Promise.all([
    listClasses(ctx, actor.permissions, { from: day, to: day, includeCancelled: true }),
    canManage
      ? listClassTypes(ctx, actor.permissions)
      : Promise.resolve([]),
    canManage && holds(session, 'staff.profile.read')
      ? listTrainers(ctx, actor.permissions)
      : Promise.resolve([]),
  ]);

  const live = timetable.rows.filter((row) => row.status !== 'CANCELLED');
  const places = live.reduce((sum, row) => sum + row.placesLeft, 0);
  const booked = live.reduce((sum, row) => sum + row.bookedCount, 0);
  const waiting = live.reduce((sum, row) => sum + row.waitlistCount, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Classes"
        subtitle={live.length === 1 ? '1 class on this day' : `${live.length} classes on this day`}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Classes" value={live.length} hint="Not cancelled" />
        <StatTile label="Booked in" value={booked} hint="Across the day" />
        <StatTile
          label="Places left"
          value={places}
          tone={places === 0 && live.length > 0 ? 'warn' : 'good'}
          hint="Still sellable"
        />
        <StatTile
          label="Waiting"
          value={waiting}
          tone={waiting > 0 ? 'warn' : 'good'}
          hint="On waitlists"
        />
      </div>

      {canManage && types.length > 0 && (
        <SchedulePanel
          day={day}
          types={types.map((type) => ({
            id: type.id,
            name: type.name,
            defaultCapacity: type.defaultCapacity,
            defaultDurationMinutes: type.defaultDurationMinutes,
          }))}
          trainers={trainers.map((trainer) => ({
            id: trainer.orgUserId,
            name: trainer.fullName,
          }))}
        />
      )}

      {canManage && types.length === 0 && (
        <Card title="Nothing to schedule yet">
          <p className="text-base text-ink-muted">
            A class on the timetable is a session of something the gym offers — Yoga, Spin,
            HIIT. Add what you run first, then put sessions of it on the timetable.
          </p>
          <div className="mt-3">
            <SchedulePanel day={day} types={[]} trainers={[]} typesOnly />
          </div>
        </Card>
      )}

      <DayPicker day={day} />

      {timetable.rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing on this day"
            description="Pick another day, or put a class on the timetable."
          />
        </Card>
      ) : (
        <ClassList rows={timetable.rows} />
      )}
    </div>
  );
}
