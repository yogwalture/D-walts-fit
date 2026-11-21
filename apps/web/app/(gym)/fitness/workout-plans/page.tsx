import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listWorkoutPlans, listWorkoutAssignments } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Workouts' };

/**
 * The plans a gym has written, and who is on them.
 *
 * The number that matters on this screen is "members on it", because that is
 * what a trainer needs before editing: a plan with 40 people on it is 40
 * people's next session.
 */
export default async function WorkoutPlansPage() {
  const { session, actor, ctx } = await requireActor('/fitness/workout-plans');
  if (!holds(session, 'fitness.workout.read')) notFound();

  const [plans, assignments] = await Promise.all([
    listWorkoutPlans(ctx, actor.permissions, { includeInactive: true }),
    listWorkoutAssignments(ctx, actor.permissions, {}),
  ]);

  const live = plans.filter((plan) => plan.isActive);
  const retired = plans.filter((plan) => !plan.isActive);
  const unassigned = assignments.filter((row) => row.sessionsLogged === 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Workouts</h1>
          <p className="mt-1 text-base text-ink-muted">
            Plans your trainers write, and the members following them. A member sees their plan
            in the app, with what they lifted last time on every exercise.
          </p>
        </div>
        {holds(session, 'fitness.workout.manage') && (
          <Link href="/fitness/workout-plans/new" className="btn-primary">
            New plan
          </Link>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="Plans" value={String(live.length)} note={`${retired.length} retired`} />
        <Tile
          label="Members on a plan"
          value={String(assignments.length)}
          note={
            assignments.length === 0
              ? 'Nobody assigned yet'
              : `${assignments.filter((row) => row.sessionsLogged > 0).length} have logged a session`
          }
        />
        <Tile
          label="Assigned, never logged"
          value={String(unassigned.length)}
          note={unassigned.length > 0 ? 'Worth a word at the desk' : 'Everyone has started'}
        />
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-lg font-semibold text-ink">Plans</h2>
        </div>

        {plans.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-base text-ink-muted">
              No plans yet. A plan is a week of training a trainer writes once and assigns to as
              many members as they like.
            </p>
            {holds(session, 'fitness.workout.manage') && (
              <Link href="/fitness/workout-plans/new" className="btn-primary mt-4 inline-flex">
                Write the first one
              </Link>
            )}
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="border-b border-line bg-surface-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                  Plan
                </th>
                <th scope="col" className="hidden px-4 py-2.5 text-sm font-semibold text-ink-muted sm:table-cell">
                  Shape
                </th>
                <th scope="col" className="px-4 py-2.5 text-sm font-semibold text-ink-muted">
                  On it
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {plans.map((plan) => (
                <tr key={plan.id} className={plan.isActive ? '' : 'opacity-60'}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/fitness/workout-plans/${plan.id}`}
                      className="text-base font-medium text-ink underline-offset-2 hover:underline"
                    >
                      {plan.name}
                    </Link>
                    <p className="text-sm text-ink-muted">
                      {plan.goal ?? plan.difficulty.toLowerCase()}
                      {plan.isActive ? '' : ' · retired'}
                    </p>
                  </td>
                  <td className="hidden px-4 py-3 text-base text-ink-muted sm:table-cell">
                    {plan.daysWritten} {plan.daysWritten === 1 ? 'day' : 'days'} ·{' '}
                    {plan.exercises} exercises · {plan.durationWeeks} weeks
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                        plan.activeMembers > 0
                          ? 'bg-accent-soft text-accent'
                          : 'bg-surface-muted text-ink-muted'
                      }`}
                    >
                      {plan.activeMembers}{' '}
                      {plan.activeMembers === 1 ? 'member' : 'members'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {assignments.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-lg font-semibold text-ink">Who is training what</h2>
          </div>
          <ul className="divide-y divide-line">
            {assignments.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-base text-ink">
                    {row.memberName}{' '}
                    <span className="text-sm text-ink-subtle">{row.memberCode}</span>
                  </p>
                  <p className="text-sm text-ink-muted">
                    {row.planName} · since {row.startDate}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-base tabular-nums text-ink">{row.sessionsLogged}</p>
                  <p className="text-sm text-ink-subtle">
                    {row.sessionsLogged === 0
                      ? 'not started'
                      : `last on ${row.lastLoggedOn}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card p-5">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-sm text-ink-subtle">{note}</p>
    </div>
  );
}
