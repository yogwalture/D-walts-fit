'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Item {
  id: string;
  exerciseName: string;
  muscleGroup: string;
  instructions: string | null;
  cautions: string | null;
  sets: number | null;
  reps: string | null;
  weightKg: string | null;
  restSeconds: number | null;
  tempo: string | null;
  trainerNotes: string | null;
  lastLogged: { weightKg: string | null; repsCompleted: string | null; on: string } | null;
}

interface Day {
  id: string;
  label: string;
  focus: string | null;
  isRestDay: boolean;
  notes: string | null;
  lastDoneOn: string | null;
  items: Item[];
}

/**
 * One day of the plan, and logging it.
 *
 * The whole day is sent in one request: somebody finishes, fills the sheet
 * in and puts the phone away. Logging exercise by exercise would mean a
 * dozen requests from a gym floor with bad signal, and half a session
 * recorded when one of them fails.
 *
 * Each field starts pre-filled with what they lifted last time rather than
 * with the plan's number, because the honest default is "the same again" —
 * and it makes beating it one keystroke.
 */
export function WorkoutDay({ day, defaultOpen }: { day: Day; defaultOpen: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [logging, setLogging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [entries, setEntries] = useState<
    Record<string, { sets?: string; reps?: string; weightKg?: string; effort?: string }>
  >(() =>
    Object.fromEntries(
      day.items.map((item) => [
        item.id,
        {
          sets: item.sets ? String(item.sets) : '',
          reps: item.lastLogged?.repsCompleted ?? item.reps ?? '',
          weightKg: item.lastLogged?.weightKg ?? item.weightKg ?? '',
          effort: '',
        },
      ]),
    ),
  );

  async function save() {
    setBusy(true);
    setError(null);

    const response = await fetch('/api/v1/portal/workout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dayId: day.id,
        entries: day.items.map((item) => {
          const entry = entries[item.id] ?? {};
          return {
            planItemId: item.id,
            setsCompleted: entry.sets ? Number(entry.sets) : undefined,
            repsCompleted: entry.reps || undefined,
            weightKg: entry.weightKg || undefined,
            perceivedEffort: entry.effort ? Number(entry.effort) : undefined,
          };
        }),
      }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'That could not be saved.');
      return;
    }

    setDone('Logged. Well done.');
    setLogging(false);
    router.refresh();
  }

  if (day.isRestDay) {
    return (
      <div className="card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-base font-medium text-ink">{day.label}</p>
          <p className="text-sm text-ink-muted">Rest</p>
        </div>
        {day.notes && <p className="mt-1 text-sm text-ink-muted">{day.notes}</p>}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-3 px-4 py-3 text-left"
      >
        <span>
          <span className="text-base font-medium text-ink">{day.label}</span>
          {day.focus && <span className="ml-2 text-sm text-ink-muted">{day.focus}</span>}
        </span>
        <span className="shrink-0 text-sm text-ink-subtle">
          {day.lastDoneOn ? `done ${day.lastDoneOn}` : 'not yet done'}
        </span>
      </button>

      {open && (
        <div className="border-t border-line">
          {done && (
            <p role="status" className="px-4 pt-3 text-sm text-accent">
              {done}
            </p>
          )}
          {error && (
            <p role="alert" className="px-4 pt-3 text-sm text-danger">
              {error}
            </p>
          )}

          <ul className="divide-y divide-line">
            {day.items.map((item) => (
              <li key={item.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-base font-medium text-ink">{item.exerciseName}</p>
                  <p className="text-base tabular-nums text-ink-muted">
                    {[
                      item.sets ? `${item.sets} × ` : '',
                      item.reps ?? '',
                      item.weightKg ? ` @ ${Number(item.weightKg)} kg` : '',
                    ].join('')}
                  </p>
                </div>

                {item.lastLogged && (
                  <p className="text-sm text-ink-subtle">
                    Last time: {item.lastLogged.repsCompleted ?? '—'}
                    {item.lastLogged.weightKg
                      ? ` at ${Number(item.lastLogged.weightKg)} kg`
                      : ''}{' '}
                    on {item.lastLogged.on}
                  </p>
                )}

                {item.trainerNotes && (
                  <p className="mt-1 text-sm text-ink-muted">{item.trainerNotes}</p>
                )}
                {item.cautions && <p className="mt-1 text-sm text-warning">{item.cautions}</p>}
                {item.restSeconds && (
                  <p className="mt-1 text-sm text-ink-subtle">
                    Rest {item.restSeconds} seconds between sets.
                  </p>
                )}

                {logging && (
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    <input
                      aria-label={`Sets of ${item.exerciseName}`}
                      value={entries[item.id]?.sets ?? ''}
                      onChange={(event) =>
                        setEntries({
                          ...entries,
                          [item.id]: { ...entries[item.id], sets: event.target.value },
                        })
                      }
                      placeholder="Sets"
                      inputMode="numeric"
                      className="input"
                    />
                    <input
                      aria-label={`Reps of ${item.exerciseName}`}
                      value={entries[item.id]?.reps ?? ''}
                      onChange={(event) =>
                        setEntries({
                          ...entries,
                          [item.id]: { ...entries[item.id], reps: event.target.value },
                        })
                      }
                      placeholder="Reps"
                      className="input"
                    />
                    <input
                      aria-label={`Weight for ${item.exerciseName}`}
                      value={entries[item.id]?.weightKg ?? ''}
                      onChange={(event) =>
                        setEntries({
                          ...entries,
                          [item.id]: { ...entries[item.id], weightKg: event.target.value },
                        })
                      }
                      placeholder="kg"
                      inputMode="decimal"
                      className="input"
                    />
                    <input
                      aria-label={`How hard ${item.exerciseName} felt, 1 to 10`}
                      value={entries[item.id]?.effort ?? ''}
                      onChange={(event) =>
                        setEntries({
                          ...entries,
                          [item.id]: { ...entries[item.id], effort: event.target.value },
                        })
                      }
                      placeholder="1-10"
                      inputMode="numeric"
                      className="input"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="flex gap-2 border-t border-line px-4 py-3">
            {logging ? (
              <>
                <button type="button" onClick={save} disabled={busy} className="btn-primary flex-1">
                  {busy ? 'Saving…' : 'Save this session'}
                </button>
                <button
                  type="button"
                  onClick={() => setLogging(false)}
                  className="btn-secondary"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setLogging(true);
                  setDone(null);
                }}
                className="btn-primary w-full"
              >
                Log this session
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
