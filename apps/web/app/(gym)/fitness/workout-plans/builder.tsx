'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

interface Exercise {
  id: string;
  name: string;
  muscleGroup: string;
  cautions: string | null;
}

interface Item {
  exerciseId: string;
  sets?: string;
  reps?: string;
  weightKg?: string;
  restSeconds?: string;
  trainerNotes?: string;
}

interface Day {
  label: string;
  focus?: string;
  isRestDay: boolean;
  notes?: string;
  items: Item[];
}

export interface BuilderPlan {
  id?: string;
  name: string;
  goal?: string;
  description?: string;
  difficulty: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
  durationWeeks: string;
  days: Day[];
}

/**
 * Writing a week of training.
 *
 * The shape of this follows how a trainer talks about it: a week is a list
 * of days, a day is a list of exercises with sets and reps beside each. Not
 * a wizard, and not one exercise per page — somebody writing a six-day plan
 * wants the whole week in front of them.
 *
 * Everything is kept in state and sent in one request, because a plan with
 * three of its six days saved is worse than no plan: the member assigned to
 * it trains half a week.
 */
export function PlanBuilder({
  exercises,
  initial,
  activeMembers = 0,
}: {
  exercises: Exercise[];
  initial?: BuilderPlan;
  activeMembers?: number;
}) {
  const router = useRouter();

  const [plan, setPlan] = useState<BuilderPlan>(
    initial ?? {
      name: '',
      difficulty: 'BEGINNER',
      durationWeeks: '4',
      days: [{ label: 'Day 1', isRestDay: false, items: [] }],
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(exercises.map((exercise) => [exercise.id, exercise])),
    [exercises],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, Exercise[]>();
    for (const exercise of exercises) {
      const list = groups.get(exercise.muscleGroup) ?? [];
      list.push(exercise);
      groups.set(exercise.muscleGroup, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [exercises]);

  function patchDay(index: number, patch: Partial<Day>) {
    setPlan((current) => ({
      ...current,
      days: current.days.map((day, at) => (at === index ? { ...day, ...patch } : day)),
    }));
  }

  function patchItem(dayIndex: number, itemIndex: number, patch: Partial<Item>) {
    setPlan((current) => ({
      ...current,
      days: current.days.map((day, at) =>
        at === dayIndex
          ? {
              ...day,
              items: day.items.map((item, i) => (i === itemIndex ? { ...item, ...patch } : item)),
            }
          : day,
      ),
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);

    const body = {
      name: plan.name,
      goal: plan.goal || undefined,
      description: plan.description || undefined,
      difficulty: plan.difficulty,
      durationWeeks: Number(plan.durationWeeks) || 4,
      days: plan.days.map((day) => ({
        label: day.label,
        focus: day.focus || undefined,
        isRestDay: day.isRestDay,
        notes: day.notes || undefined,
        items: day.isRestDay
          ? []
          : day.items.map((item) => ({
              exerciseId: item.exerciseId,
              sets: item.sets ? Number(item.sets) : undefined,
              reps: item.reps || undefined,
              weightKg: item.weightKg || undefined,
              restSeconds: item.restSeconds ? Number(item.restSeconds) : undefined,
              trainerNotes: item.trainerNotes || undefined,
            })),
      })),
    };

    const response = await fetch(
      plan.id ? `/api/v1/fitness/workouts/${plan.id}` : '/api/v1/fitness/workouts',
      {
        method: plan.id ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      // The service names the day that is wrong, so this shows it as-is
      // rather than flattening it to "check your input".
      setError(payload?.error?.message ?? 'That plan could not be saved.');
      return;
    }

    const id = plan.id ?? payload?.data?.id;
    router.push(id ? `/fitness/workout-plans/${id}` : '/fitness/workout-plans');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {activeMembers > 0 && (
        <div className="rounded-card border border-warning/30 bg-warning/5 px-4 py-3 text-base text-ink">
          {activeMembers} {activeMembers === 1 ? 'member is' : 'members are'} on this plan.
          Saving changes what they do at their next session.
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <section className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className="label">
              Plan name
            </label>
            <input
              id="name"
              value={plan.name}
              onChange={(event) => setPlan({ ...plan, name: event.target.value })}
              placeholder="Beginner strength"
              className="input mt-1.5"
            />
          </div>
          <div>
            <label htmlFor="goal" className="label">
              Goal
            </label>
            <input
              id="goal"
              value={plan.goal ?? ''}
              onChange={(event) => setPlan({ ...plan, goal: event.target.value })}
              placeholder="Build strength and confidence with the bar"
              className="input mt-1.5"
            />
          </div>
          <div>
            <label htmlFor="difficulty" className="label">
              Level
            </label>
            <select
              id="difficulty"
              value={plan.difficulty}
              onChange={(event) =>
                setPlan({ ...plan, difficulty: event.target.value as BuilderPlan['difficulty'] })
              }
              className="input mt-1.5"
            >
              <option value="BEGINNER">Beginner</option>
              <option value="INTERMEDIATE">Intermediate</option>
              <option value="ADVANCED">Advanced</option>
            </select>
          </div>
          <div>
            <label htmlFor="durationWeeks" className="label">
              Weeks
            </label>
            <input
              id="durationWeeks"
              type="number"
              min={1}
              max={52}
              value={plan.durationWeeks}
              onChange={(event) => setPlan({ ...plan, durationWeeks: event.target.value })}
              className="input mt-1.5"
            />
            <p className="mt-1 text-sm text-ink-subtle">
              Sets the end date when somebody is assigned to it.
            </p>
          </div>
        </div>
      </section>

      {plan.days.map((day, dayIndex) => (
        <section key={dayIndex} className="card p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap gap-3">
              <div>
                <label htmlFor={`day-${dayIndex}`} className="label">
                  Day {dayIndex + 1}
                </label>
                <input
                  id={`day-${dayIndex}`}
                  value={day.label}
                  onChange={(event) => patchDay(dayIndex, { label: event.target.value })}
                  className="input mt-1.5 w-40"
                />
              </div>
              <div>
                <label htmlFor={`focus-${dayIndex}`} className="label">
                  Focus
                </label>
                <input
                  id={`focus-${dayIndex}`}
                  value={day.focus ?? ''}
                  onChange={(event) => patchDay(dayIndex, { focus: event.target.value })}
                  placeholder="Chest and shoulders"
                  className="input mt-1.5 w-56"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-base text-ink">
                <input
                  type="checkbox"
                  checked={day.isRestDay}
                  onChange={(event) =>
                    patchDay(dayIndex, { isRestDay: event.target.checked, items: [] })
                  }
                />
                Rest day
              </label>
              {plan.days.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-sm"
                  onClick={() =>
                    setPlan({ ...plan, days: plan.days.filter((_, at) => at !== dayIndex) })
                  }
                >
                  Remove day
                </button>
              )}
            </div>
          </div>

          {!day.isRestDay && (
            <div className="mt-4 space-y-3 border-t border-line pt-4">
              {day.items.length === 0 && (
                <p className="text-sm text-ink-muted">
                  Nothing in this day yet. Add an exercise, or mark it a rest day.
                </p>
              )}

              {day.items.map((item, itemIndex) => {
                const exercise = byId.get(item.exerciseId);
                return (
                  <div key={itemIndex} className="rounded-control border border-line p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-medium text-ink">
                          {exercise?.name ?? 'Unknown exercise'}
                        </p>
                        <p className="text-sm text-ink-muted">{exercise?.muscleGroup}</p>
                        {exercise?.cautions && (
                          <p className="mt-1 text-sm text-warning">{exercise.cautions}</p>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn-ghost shrink-0 px-2 py-1 text-sm"
                        onClick={() =>
                          patchDay(dayIndex, {
                            items: day.items.filter((_, at) => at !== itemIndex),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-4">
                      <input
                        aria-label="Sets"
                        value={item.sets ?? ''}
                        onChange={(event) =>
                          patchItem(dayIndex, itemIndex, { sets: event.target.value })
                        }
                        placeholder="Sets"
                        className="input"
                      />
                      <input
                        aria-label="Reps"
                        value={item.reps ?? ''}
                        onChange={(event) =>
                          patchItem(dayIndex, itemIndex, { reps: event.target.value })
                        }
                        placeholder="Reps — 8-10"
                        className="input"
                      />
                      <input
                        aria-label="Weight in kg"
                        value={item.weightKg ?? ''}
                        onChange={(event) =>
                          patchItem(dayIndex, itemIndex, { weightKg: event.target.value })
                        }
                        placeholder="kg"
                        className="input"
                      />
                      <input
                        aria-label="Rest in seconds"
                        value={item.restSeconds ?? ''}
                        onChange={(event) =>
                          patchItem(dayIndex, itemIndex, { restSeconds: event.target.value })
                        }
                        placeholder="Rest (s)"
                        className="input"
                      />
                    </div>

                    <input
                      aria-label="Note for the member"
                      value={item.trainerNotes ?? ''}
                      onChange={(event) =>
                        patchItem(dayIndex, itemIndex, { trainerNotes: event.target.value })
                      }
                      placeholder="A note the member will read — “stop one short of failure”"
                      className="input mt-2"
                    />
                  </div>
                );
              })}

              <select
                aria-label={`Add an exercise to ${day.label || `day ${dayIndex + 1}`}`}
                value=""
                onChange={(event) => {
                  if (!event.target.value) return;
                  patchDay(dayIndex, {
                    items: [...day.items, { exerciseId: event.target.value }],
                  });
                }}
                className="input"
              >
                <option value="">Add an exercise…</option>
                {grouped.map(([muscleGroup, list]) => (
                  <optgroup key={muscleGroup} label={muscleGroup}>
                    {list.map((exercise) => (
                      <option key={exercise.id} value={exercise.id}>
                        {exercise.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-secondary"
          disabled={plan.days.length >= 14}
          onClick={() =>
            setPlan({
              ...plan,
              days: [
                ...plan.days,
                { label: `Day ${plan.days.length + 1}`, isRestDay: false, items: [] },
              ],
            })
          }
        >
          Add a day
        </button>

        <button type="button" onClick={save} disabled={busy} className="btn-primary">
          {busy ? 'Saving…' : plan.id ? 'Save the plan' : 'Create the plan'}
        </button>

        <p className="text-sm text-ink-subtle">
          {plan.days.filter((day) => !day.isRestDay).length} training{' '}
          {plan.days.filter((day) => !day.isRestDay).length === 1 ? 'day' : 'days'} ·{' '}
          {plan.days.reduce((sum, day) => sum + day.items.length, 0)} exercises
        </p>
      </div>
    </div>
  );
}
