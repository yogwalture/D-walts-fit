'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Putting a class on the timetable, and adding a kind of class.
 *
 * The repeat is the part worth getting right: a gym runs the 7am Yoga every
 * weekday, and entering it once per day for a term is what makes people give
 * up on software. Weekdays and a number of weeks is enough, and the result
 * says which weeks could not be created rather than failing the lot.
 */

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
] as const;

interface ClassTypeOption {
  id: string;
  name: string;
  defaultCapacity: number;
  defaultDurationMinutes: number;
}

export function SchedulePanel({
  day,
  types,
  trainers,
  typesOnly = false,
}: {
  day: string;
  types: ClassTypeOption[];
  trainers: Array<{ id: string; name: string }>;
  typesOnly?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [mode, setMode] = useState<'closed' | 'session' | 'type'>('closed');
  const [repeatOn, setRepeatOn] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ startsAt: string; reason: string }>>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setMode('closed');
    setRepeatOn([]);
    setMessage(null);
    setSkipped([]);
    setFieldErrors({});
  }

  async function post(url: string, body: unknown): Promise<any | null> {
    setMessage(null);
    setSkipped([]);
    setFieldErrors({});
    setSubmitting(true);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      const error = payload?.error;
      if (error?.details?.length) {
        setFieldErrors(
          Object.fromEntries(
            error.details.map((d: { field: string; issue: string }) => [d.field, d.issue]),
          ),
        );
      }
      setMessage(error?.message ?? 'Something went wrong. Please try again.');
      return null;
    }

    return payload?.data ?? {};
  }

  async function onSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const date = text('date') ?? day;
    const at = text('time') ?? '07:00';
    // Built from local parts so the time entered is the time the gym meant.
    const startsAt = new Date(`${date}T${at}:00`).toISOString();

    const result = await post('/api/v1/classes/schedule', {
      classTypeId: text('classTypeId'),
      trainerOrgUserId: text('trainerOrgUserId'),
      title: text('title'),
      startsAt,
      durationMinutes: text('durationMinutes'),
      capacity: text('capacity'),
      room: text('room'),
      repeatOn,
      repeatWeeks: repeatOn.length > 0 ? (text('repeatWeeks') ?? '8') : 0,
    });

    if (!result) return;

    if (result.skipped?.length) {
      // Reported rather than swallowed: the manager needs to know which
      // evenings did not get a class and why.
      setSkipped(result.skipped);
      setMessage(
        `${result.ids.length} scheduled. ${result.skipped.length} could not be — see below.`,
      );
      startTransition(() => router.refresh());
      return;
    }

    reset();
    startTransition(() => router.refresh());
  }

  async function onAddType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const result = await post('/api/v1/classes/types', {
      name: text('name'),
      defaultCapacity: text('defaultCapacity') ?? '20',
      defaultDurationMinutes: text('defaultDurationMinutes') ?? '60',
      colorHex: text('colorHex'),
    });
    if (!result) return;

    reset();
    startTransition(() => router.refresh());
  }

  if (mode === 'closed') {
    return (
      <div className="flex flex-wrap gap-2">
        {!typesOnly && types.length > 0 && (
          <button type="button" className="btn-primary" onClick={() => setMode('session')}>
            Put a class on the timetable
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={() => setMode('type')}>
          Add a kind of class
        </button>
      </div>
    );
  }

  return (
    <section className="card p-5">
      {message && (
        <div
          role="alert"
          className="mb-4 rounded-control border border-warn/20 bg-warn/5 px-3 py-2 text-sm text-ink"
        >
          {message}
        </div>
      )}

      {skipped.length > 0 && (
        <ul className="mb-4 space-y-1 rounded-control border border-line bg-canvas px-3 py-2">
          {skipped.map((item) => (
            <li key={item.startsAt} className="text-sm text-ink-muted">
              {new Date(item.startsAt).toLocaleString('en-IN', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })}{' '}
              — {item.reason}
            </li>
          ))}
        </ul>
      )}

      {mode === 'session' ? (
        <form onSubmit={onSchedule} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Class" error={fieldErrors.classTypeId}>
              <select id="classTypeId" name="classTypeId" className="input" required>
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Trainer" hint="Optional — a clash is refused">
              <select id="trainerOrgUserId" name="trainerOrgUserId" className="input">
                <option value="">Nobody yet</option>
                {trainers.map((trainer) => (
                  <option key={trainer.id} value={trainer.id}>
                    {trainer.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Date" error={fieldErrors.startsAt}>
              <input id="date" name="date" type="date" className="input" defaultValue={day} required />
            </Field>

            <Field label="Start time">
              <input id="time" name="time" type="time" className="input" defaultValue="07:00" required />
            </Field>

            <Field label="Minutes" error={fieldErrors.durationMinutes}>
              <input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min={5}
                max={480}
                className="input"
                placeholder={String(types[0]?.defaultDurationMinutes ?? 60)}
              />
            </Field>

            <Field label="Places" error={fieldErrors.capacity} hint="Defaults to the class's own">
              <input
                id="capacity"
                name="capacity"
                type="number"
                min={1}
                max={500}
                className="input"
                placeholder={String(types[0]?.defaultCapacity ?? 20)}
              />
            </Field>

            <Field label="Room">
              <input id="room" name="room" className="input" placeholder="Studio 1" />
            </Field>

            <Field label="Title" hint="Only if it differs from the class name">
              <input id="title" name="title" className="input" />
            </Field>
          </div>

          <fieldset className="rounded-control border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink">Repeat weekly</legend>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((weekday) => {
                const on = repeatOn.includes(weekday.value);
                return (
                  <button
                    key={weekday.value}
                    type="button"
                    aria-pressed={on}
                    className={on ? 'btn-primary px-3' : 'btn-secondary px-3'}
                    onClick={() =>
                      setRepeatOn((current) =>
                        current.includes(weekday.value)
                          ? current.filter((d) => d !== weekday.value)
                          : [...current, weekday.value],
                      )
                    }
                  >
                    {weekday.label}
                  </button>
                );
              })}
            </div>
            {repeatOn.length > 0 && (
              <div className="mt-3 max-w-[12rem]">
                <Field label="For how many weeks" hint="Up to 12 at a time">
                  <input
                    id="repeatWeeks"
                    name="repeatWeeks"
                    type="number"
                    min={1}
                    max={12}
                    defaultValue={8}
                    className="input"
                  />
                </Field>
              </div>
            )}
            <p className="mt-2 text-sm text-ink-subtle">
              Sessions are created as real entries up to twelve weeks ahead. Nothing extends
              them on its own, so the result tells you where the timetable ends.
            </p>
          </fieldset>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Scheduling…' : 'Schedule'}
            </button>
            <button type="button" className="btn-secondary" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={onAddType} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={fieldErrors.name}>
              <input id="name" name="name" className="input" placeholder="Yoga" required autoFocus />
            </Field>
            <Field label="Usual places" error={fieldErrors.defaultCapacity}>
              <input
                id="defaultCapacity"
                name="defaultCapacity"
                type="number"
                min={1}
                max={500}
                defaultValue={20}
                className="input"
              />
            </Field>
            <Field label="Usual minutes" error={fieldErrors.defaultDurationMinutes}>
              <input
                id="defaultDurationMinutes"
                name="defaultDurationMinutes"
                type="number"
                min={5}
                max={480}
                defaultValue={60}
                className="input"
              />
            </Field>
            <Field label="Colour" hint="Shown against each session">
              <input id="colorHex" name="colorHex" type="color" defaultValue="#16A34A" className="input h-10" />
            </Field>
          </div>

          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add class'}
            </button>
            <button type="button" className="btn-secondary" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-ink">{label}</label>
      {children}
      {error ? (
        <p className="mt-1 text-sm text-danger">{error}</p>
      ) : (
        hint && <p className="mt-1 text-sm text-ink-subtle">{hint}</p>
      )}
    </div>
  );
}
