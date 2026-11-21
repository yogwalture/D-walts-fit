import type { Metadata } from 'next';
import { myWorkout, workoutProgress } from '@gym/core';
import { requireActor } from '@/lib/current-session';
import { memberContextOf } from '@/lib/tenant';
import { Card, EmptyState } from '@/components/ui';
import { WorkoutDay } from './day';

export const metadata: Metadata = { title: 'Workout' };
export const dynamic = 'force-dynamic';

/**
 * A member's plan, on their phone, at the rack.
 *
 * Opens on the day they have done least recently, because somebody standing
 * in the gym wants today's session, not a table of contents. Every exercise
 * carries what they lifted last time — that is the number they are trying to
 * beat, and a plan that says "3 x 8" without it leaves them guessing.
 */
export default async function MyWorkoutPage() {
  const { actor } = await requireActor('/my/workout');
  const ctx = memberContextOf(actor);

  const [workout, progress] = await Promise.all([
    myWorkout(ctx, actor.permissions),
    workoutProgress(ctx, actor.permissions),
  ]);

  if (!workout) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Workout</h1>
        <Card>
          <EmptyState
            title="No plan yet"
            description="Ask at the desk and a trainer will put one together for you. It will show up here."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{workout.planName}</h1>
        <p className="mt-1 text-base text-ink-muted">
          {workout.planGoal ?? 'Your current plan'}
          {workout.endDate ? ` · until ${workout.endDate}` : ''}
        </p>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-2xl font-semibold tabular-nums text-ink">
              {progress.sessionsThisMonth}
            </p>
            <p className="text-sm text-ink-muted">sessions this month</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums text-ink">
              {progress.sessionsLogged}
            </p>
            <p className="text-sm text-ink-muted">
              {progress.lastLoggedOn ? `last on ${progress.lastLoggedOn}` : 'none logged yet'}
            </p>
          </div>
        </div>
      </Card>

      {workout.days.map((day) => (
        <WorkoutDay
          key={day.id}
          day={day}
          // Open on the suggested day so the first thing on screen is the
          // session to do now.
          defaultOpen={day.id === workout.suggestedDayId}
        />
      ))}

      {progress.bests.length > 0 && (
        <Card title="Your best lifts">
          <ul className="space-y-1.5">
            {progress.bests.slice(0, 8).map((best) => (
              <li key={best.exerciseName} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-base text-ink">{best.exerciseName}</span>
                <span className="shrink-0 text-base tabular-nums text-ink-muted">
                  {Number(best.weightKg)} kg
                  {best.reps ? ` × ${best.reps}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
