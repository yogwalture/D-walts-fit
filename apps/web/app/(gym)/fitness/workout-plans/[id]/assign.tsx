'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Member {
  id: string;
  name: string;
  memberCode: string;
}

interface Assigned {
  id: string;
  memberName: string;
  memberCode: string;
  startDate: string;
  sessionsLogged: number;
  lastLoggedOn: string | null;
}

/**
 * Putting members on the plan, and seeing who is following it.
 *
 * Assigning says what it replaced, because a member is on exactly one plan
 * and "moved from Beginner" is the thing a trainer needs to see confirmed —
 * silently swapping somebody's training is how a member turns up to do the
 * wrong session.
 */
export function AssignPanel({
  planId,
  planName,
  members,
  assigned,
}: {
  planId: string;
  planName: string;
  members: Member[];
  assigned: Assigned[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onItAlready = new Set(assigned.map((row) => row.memberCode));
  const available = members.filter((member) => !onItAlready.has(member.memberCode));

  async function assign(memberId: string) {
    setBusy(true);
    setError(null);
    setDone(null);

    const response = await fetch('/api/v1/fitness/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'assign', memberId, planId }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'That could not be assigned.');
      return;
    }

    const replaced = payload?.data?.replaced;
    setDone(
      replaced
        ? `Moved onto ${planName}, from ${replaced}.`
        : `Put onto ${planName}.`,
    );
    router.refresh();
  }

  async function end(assignmentId: string) {
    setBusy(true);
    setError(null);

    const response = await fetch('/api/v1/fitness/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'end', assignmentId, status: 'COMPLETED' }),
    });

    setBusy(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error?.message ?? 'That could not be changed.');
      return;
    }

    setDone('Taken off the plan.');
    router.refresh();
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg font-semibold text-ink">Members on this plan</h2>

      {done && (
        <p role="status" className="mt-2 text-sm text-accent">
          {done}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {assigned.length === 0 ? (
        <p className="mt-2 text-base text-ink-muted">Nobody is on this plan yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {assigned.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-base text-ink">
                  {row.memberName} <span className="text-sm text-ink-subtle">{row.memberCode}</span>
                </p>
                <p className="text-sm text-ink-muted">
                  since {row.startDate} ·{' '}
                  {row.sessionsLogged === 0
                    ? 'no sessions logged yet'
                    : `${row.sessionsLogged} ${row.sessionsLogged === 1 ? 'session' : 'sessions'}, last on ${row.lastLoggedOn}`}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => end(row.id)}
                className="btn-ghost shrink-0 px-2 py-1 text-sm"
              >
                Take off
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-line pt-4">
        <label htmlFor="assign-member" className="label">
          Put somebody on it
        </label>
        <select
          id="assign-member"
          value=""
          disabled={busy || available.length === 0}
          onChange={(event) => {
            if (event.target.value) void assign(event.target.value);
          }}
          className="input mt-1.5"
        >
          <option value="">
            {available.length === 0 ? 'Everybody active is already on it' : 'Choose a member…'}
          </option>
          {available.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} — {member.memberCode}
            </option>
          ))}
        </select>
        <p className="mt-1 text-sm text-ink-subtle">
          A member follows one plan at a time, so this moves them off whatever they are on.
        </p>
      </div>
    </section>
  );
}
