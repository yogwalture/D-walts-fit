'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Overrides = Record<string, number | null | undefined>;

/**
 * The two things a sales conversation needs to be able to do without
 * finding an engineer: give somebody another week, and honour a limit that
 * was agreed on a call.
 *
 * Both demand a reason in the same breath as the change, because both are
 * written into that gym's own audit log and somebody will ask why later.
 */
export function GymActions({
  organizationId,
  isTrial,
  overrides,
}: {
  organizationId: string;
  isTrial: boolean;
  overrides: Overrides;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<'trial' | 'limits' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function post(path: string, body: unknown, success: string) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/v1/platform/gyms/${organizationId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'That did not go through.');
      return;
    }

    setDone(success);
    setOpen(null);
    router.refresh();
  }

  function onExtend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void post(
      'trial',
      { days: Number(form.get('days') ?? 7), reason: String(form.get('reason') ?? '') },
      'Trial extended.',
    );
  }

  function onLimits(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    // An empty field is "leave it on the plan", which is not the same as
    // typing 0. Only what was filled in is sent.
    const next: Record<string, number | null> = {};
    for (const key of ['maxMembers', 'maxBranches', 'maxStaff']) {
      const raw = String(form.get(key) ?? '').trim();
      if (raw === '') continue;
      next[key] = raw.toLowerCase() === 'unlimited' ? null : Number(raw);
    }

    void post(
      'limits',
      { overrides: next, reason: String(form.get('reason') ?? '') },
      Object.keys(next).length === 0 ? 'Back on their plan.' : 'Limits agreed.',
    );
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Commercial</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Both are recorded in this gym&rsquo;s own audit log, with the reason.
          </p>
        </div>
        <div className="flex gap-2">
          {isTrial && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setOpen(open === 'trial' ? null : 'trial');
                setDone(null);
              }}
            >
              Extend trial
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setOpen(open === 'limits' ? null : 'limits');
              setDone(null);
            }}
          >
            Agree limits
          </button>
        </div>
      </div>

      {done && (
        <p role="status" className="mt-3 text-sm text-accent">
          {done}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {open === 'trial' && (
        <form onSubmit={onExtend} className="mt-4 space-y-3 border-t border-line pt-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <div>
              <label htmlFor="days" className="label">
                Days
              </label>
              <input
                id="days"
                name="days"
                type="number"
                min={1}
                max={60}
                defaultValue={7}
                className="input mt-1.5"
              />
            </div>
            <div>
              <label htmlFor="trial-reason" className="label">
                Why
              </label>
              <input
                id="trial-reason"
                name="reason"
                required
                placeholder="Owner was away, asked for another week"
                className="input mt-1.5"
              />
            </div>
          </div>
          <p className="text-sm text-ink-muted">
            Counted from today if the trial has already ended, and it lifts read-only — a gym
            evaluating the software has to be able to use it.
          </p>
          <button type="submit" disabled={busy} className="btn-primary">
            {busy ? 'Extending…' : 'Extend trial'}
          </button>
        </form>
      )}

      {open === 'limits' && (
        <form onSubmit={onLimits} className="mt-4 space-y-3 border-t border-line pt-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ['maxMembers', 'Members'],
                ['maxBranches', 'Branches'],
                ['maxStaff', 'Staff'],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <label htmlFor={key} className="label">
                  {label}
                </label>
                <input
                  id={key}
                  name={key}
                  defaultValue={
                    overrides[key] === null ? 'unlimited' : (overrides[key]?.toString() ?? '')
                  }
                  placeholder="On the plan"
                  className="input mt-1.5"
                />
              </div>
            ))}
          </div>
          <div>
            <label htmlFor="limits-reason" className="label">
              Why
            </label>
            <input
              id="limits-reason"
              name="reason"
              required
              placeholder="Six sites, agreed at the price of Growth"
              className="input mt-1.5"
            />
          </div>
          <p className="text-sm text-ink-muted">
            Leave a box empty to keep their plan&rsquo;s own limit. Type{' '}
            <span className="font-medium text-ink">unlimited</span> for no cap. Clearing every
            box puts them back on the plan.
          </p>
          <button type="submit" disabled={busy} className="btn-primary">
            {busy ? 'Saving…' : 'Agree these limits'}
          </button>
        </form>
      )}
    </section>
  );
}
