import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listExercises } from '@gym/core';
import { requireActor, holds } from '@/lib/current-session';
import { PlanBuilder } from '../builder';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'New workout plan' };

export default async function NewPlanPage() {
  const { session, actor, ctx } = await requireActor('/fitness/workout-plans/new');
  if (!holds(session, 'fitness.workout.manage')) notFound();

  const exercises = await listExercises(ctx, actor.permissions, { limit: 500 });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/fitness/workout-plans" className="text-sm text-ink-muted hover:underline">
          &larr; Workouts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">A new plan</h1>
        <p className="mt-1 text-base text-ink-muted">
          A week of training, written once and assigned to as many members as you like. They see
          it in the app with your notes attached.
        </p>
      </div>

      {exercises.length === 0 ? (
        <div className="card p-5">
          <p className="text-base text-ink-muted">
            There are no exercises to build a plan from. The shared library should have some —
            if it is empty, the database has not been seeded.
          </p>
        </div>
      ) : (
        <PlanBuilder exercises={exercises} />
      )}
    </div>
  );
}
