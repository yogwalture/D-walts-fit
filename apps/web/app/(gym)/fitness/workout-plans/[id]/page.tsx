import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getWorkoutPlan,
  listExercises,
  listWorkoutAssignments,
  listMembers,
  AppError,
} from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { PlanBuilder } from '../builder';
import { AssignPanel } from './assign';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Workout plan' };

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const { edit } = await searchParams;
  const { session, actor, ctx } = await requireActor(`/fitness/workout-plans/${id}`);
  if (!holds(session, 'fitness.workout.read')) notFound();

  const plan = await getWorkoutPlan(ctx, actor.permissions, id).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  });

  const canManage = holds(session, 'fitness.workout.manage');
  const canAssign = holds(session, 'fitness.workout.assign');
  const editing = edit === '1' && canManage;

  const [exercises, assignments, members] = await Promise.all([
    editing ? listExercises(ctx, actor.permissions, { limit: 500 }) : Promise.resolve([]),
    listWorkoutAssignments(ctx, actor.permissions, { planId: id }),
    canAssign
      ? listMembers(ctx, actor.permissions, { pageSize: 100, filter: 'active' })
      : Promise.resolve({ rows: [], total: 0 }),
  ]);

  if (editing) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <Link
            href={`/fitness/workout-plans/${id}`}
            className="text-sm text-ink-muted hover:underline"
          >
            &larr; {plan.name}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
            Editing {plan.name}
          </h1>
        </div>

        <PlanBuilder
          exercises={exercises}
          activeMembers={plan.activeMembers}
          initial={{
            id: plan.id,
            name: plan.name,
            goal: plan.goal ?? undefined,
            description: plan.description ?? undefined,
            difficulty: plan.difficulty as 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
            durationWeeks: String(plan.durationWeeks),
            days: plan.days.map((day) => ({
              label: day.label,
              focus: day.focus ?? undefined,
              isRestDay: day.isRestDay,
              notes: day.notes ?? undefined,
              items: day.items.map((item) => ({
                exerciseId: item.exerciseId,
                sets: item.sets ? String(item.sets) : undefined,
                reps: item.reps ?? undefined,
                weightKg: item.weightKg ?? undefined,
                restSeconds: item.restSeconds ? String(item.restSeconds) : undefined,
                trainerNotes: item.trainerNotes ?? undefined,
              })),
            })),
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/fitness/workout-plans" className="text-sm text-ink-muted hover:underline">
            &larr; Workouts
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{plan.name}</h1>
          <p className="mt-1 text-base text-ink-muted">
            {plan.goal ?? plan.difficulty.toLowerCase()} · {plan.durationWeeks} weeks ·{' '}
            {plan.activeMembers} {plan.activeMembers === 1 ? 'member' : 'members'} on it
            {plan.isActive ? '' : ' · retired'}
          </p>
        </div>
        {canManage && (
          <Link href={`/fitness/workout-plans/${id}?edit=1`} className="btn-secondary">
            Edit the plan
          </Link>
        )}
      </div>

      {plan.description && <p className="text-base text-ink-muted">{plan.description}</p>}

      <div className="space-y-4">
        {plan.days.map((day) => (
          <section key={day.id} className="card overflow-hidden">
            <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
              <h2 className="text-lg font-semibold text-ink">{day.label}</h2>
              <p className="text-sm text-ink-muted">
                {day.isRestDay ? 'Rest' : (day.focus ?? `${day.items.length} exercises`)}
              </p>
            </div>

            {day.isRestDay ? (
              <p className="px-4 py-6 text-center text-base text-ink-muted">
                A rest day. {day.notes ?? 'Nothing scheduled.'}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {day.items.map((item) => (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-base font-medium text-ink">{item.exerciseName}</p>
                      <p className="text-base tabular-nums text-ink-muted">
                        {[
                          item.sets ? `${item.sets} sets` : null,
                          item.reps ? `${item.reps} reps` : null,
                          item.weightKg ? `${item.weightKg} kg` : null,
                          item.restSeconds ? `${item.restSeconds}s rest` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <p className="text-sm text-ink-subtle">{item.muscleGroup}</p>
                    {item.trainerNotes && (
                      <p className="mt-1 text-sm text-ink-muted">{item.trainerNotes}</p>
                    )}
                    {item.cautions && (
                      <p className="mt-1 text-sm text-warning">{item.cautions}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      {canAssign && plan.isActive && (
        <AssignPanel
          planId={plan.id}
          planName={plan.name}
          members={members.rows.map((row) => ({
            id: row.id,
            name: row.name,
            memberCode: row.memberCode,
          }))}
          assigned={assignments.map((row) => ({
            id: row.id,
            memberName: row.memberName,
            memberCode: row.memberCode,
            startDate: row.startDate,
            sessionsLogged: row.sessionsLogged,
            lastLoggedOn: row.lastLoggedOn,
          }))}
        />
      )}
    </div>
  );
}
