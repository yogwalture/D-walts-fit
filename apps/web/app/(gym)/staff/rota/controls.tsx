'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Marking the register, setting the rota, and deciding leave.
 *
 * Approving leave reports how many days it wrote onto the register, because
 * that is the thing a manager would otherwise have to go and check.
 */

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
] as const;

async function send(url: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false as const,
      message: payload?.error?.message ?? 'Something went wrong. Please try again.',
    };
  }
  return { ok: true as const, data: payload?.data ?? {} };
}

export function MarkRow({
  orgUserId,
  date,
  marked,
}: {
  orgUserId: string;
  date: string;
  marked: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    const result = await send('/api/v1/staff/attendance', 'POST', {
      orgUserId,
      date,
      ...body,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    startTransition(() => router.refresh());
  }

  if (message) {
    return <span className="text-sm text-danger">{message}</span>;
  }

  return (
    <div className="flex gap-1.5">
      {marked === null && (
        <>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => act({ action: 'IN' })}
          >
            In
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => act({ status: 'ABSENT' })}
          >
            Absent
          </button>
        </>
      )}
      {marked === 'PRESENT' && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => act({ action: 'OUT' })}
        >
          Out
        </button>
      )}
    </div>
  );
}

export function RotaControls({
  date,
  canRota,
  canApprove,
  staff,
  pending,
  shifts,
}: {
  date: string;
  canRota: boolean;
  canApprove: boolean;
  staff: Array<{ id: string; name: string }>;
  pending: Array<{
    id: string;
    fullName: string;
    leaveType: string;
    fromDate: string;
    toDate: string;
    days: string;
    reason: string | null;
  }>;
  shifts: Array<{
    id: string;
    fullName: string;
    weekday: number | null;
    shiftDate: string | null;
    startTime: string;
    endTime: string;
  }>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [mode, setMode] = useState<'closed' | 'rota' | 'leave'>('closed');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function goToDay(next: string) {
    startTransition(() => router.replace(`/staff/rota?date=${next}`));
  }

  async function decide(leaveId: string, approve: boolean) {
    setBusy(true);
    const result = await send('/api/v1/staff/leave', 'PATCH', { leaveId, approve });
    setBusy(false);

    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(
      approve
        ? `Approved. ${result.data.daysMarked} day(s) marked on the register.`
        : 'Refused.',
    );
    startTransition(() => router.refresh());
  }

  async function onShift(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await send('/api/v1/staff/shifts', 'POST', {
      orgUserId: String(form.get('orgUserId') ?? ''),
      weekday: String(form.get('weekday') ?? ''),
      startTime: String(form.get('startTime') ?? ''),
      endTime: String(form.get('endTime') ?? ''),
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setMode('closed');
    startTransition(() => router.refresh());
  }

  async function onLeave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await send('/api/v1/staff/leave', 'POST', {
      orgUserId: String(form.get('orgUserId') ?? '') || undefined,
      leaveType: String(form.get('leaveType') ?? ''),
      fromDate: String(form.get('fromDate') ?? ''),
      toDate: String(form.get('toDate') ?? ''),
      reason: String(form.get('reason') ?? '').trim() || undefined,
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setMode('closed');
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      {message && (
        <div
          role="status"
          className="rounded-control border border-line bg-canvas px-3 py-2 text-sm text-ink"
        >
          {message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          className="input max-w-[11rem]"
          aria-label="Show another day"
          value={date}
          onChange={(event) => event.target.value && goToDay(event.target.value)}
        />
        {canRota && (
          <button type="button" className="btn-secondary" onClick={() => setMode('rota')}>
            Set a shift
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={() => setMode('leave')}>
          Record leave
        </button>
      </div>

      {mode === 'rota' && (
        <form onSubmit={onShift} className="card grid gap-4 p-5 sm:grid-cols-4" noValidate>
          <div className="sm:col-span-2">
            <label htmlFor="orgUserId" className="mb-1 block text-sm font-medium text-ink">
              Who
            </label>
            <select id="orgUserId" name="orgUserId" className="input" required>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="weekday" className="mb-1 block text-sm font-medium text-ink">
              Every
            </label>
            <select id="weekday" name="weekday" className="input">
              {WEEKDAYS.map((weekday) => (
                <option key={weekday.value} value={weekday.value}>
                  {weekday.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <div>
              <label htmlFor="startTime" className="mb-1 block text-sm font-medium text-ink">
                From
              </label>
              <input id="startTime" name="startTime" type="time" className="input" defaultValue="09:00" required />
            </div>
            <div>
              <label htmlFor="endTime" className="mb-1 block text-sm font-medium text-ink">
                To
              </label>
              <input id="endTime" name="endTime" type="time" className="input" defaultValue="18:00" required />
            </div>
          </div>
          <div className="flex gap-2 sm:col-span-4">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Set shift'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setMode('closed')}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'leave' && (
        <form onSubmit={onLeave} className="card grid gap-4 p-5 sm:grid-cols-4" noValidate>
          <div className="sm:col-span-2">
            <label htmlFor="leave-who" className="mb-1 block text-sm font-medium text-ink">
              Who
            </label>
            <select id="leave-who" name="orgUserId" className="input">
              <option value="">Me</option>
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="leaveType" className="mb-1 block text-sm font-medium text-ink">
              Kind
            </label>
            <input id="leaveType" name="leaveType" className="input" defaultValue="Casual" required />
          </div>
          <div className="flex gap-2">
            <div>
              <label htmlFor="fromDate" className="mb-1 block text-sm font-medium text-ink">
                From
              </label>
              <input id="fromDate" name="fromDate" type="date" className="input" defaultValue={date} required />
            </div>
            <div>
              <label htmlFor="toDate" className="mb-1 block text-sm font-medium text-ink">
                To
              </label>
              <input id="toDate" name="toDate" type="date" className="input" defaultValue={date} required />
            </div>
          </div>
          <div className="sm:col-span-4">
            <label htmlFor="reason" className="mb-1 block text-sm font-medium text-ink">
              Reason
            </label>
            <input id="reason" name="reason" className="input" placeholder="Optional" />
          </div>
          <div className="flex gap-2 sm:col-span-4">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Record leave'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setMode('closed')}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {pending.length > 0 && (
        <section className="card p-5">
          <h2 className="text-base font-semibold text-ink">Leave to decide</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Approving marks those days on the register, so nobody is docked for an absence the
            gym agreed to.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {pending.map((leave) => (
              <li key={leave.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-ink">
                    {leave.fullName} — {leave.leaveType}, {leave.days} day
                    {leave.days === '1' ? '' : 's'}
                  </p>
                  <p className="truncate text-sm text-ink-muted">
                    {leave.fromDate} to {leave.toDate}
                    {leave.reason ? ` · ${leave.reason}` : ''}
                  </p>
                </div>
                {canApprove && (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy}
                      onClick={() => decide(leave.id, true)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() => decide(leave.id, false)}
                    >
                      Refuse
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRota && shifts.length > 0 && (
        <section className="card p-5">
          <h2 className="text-base font-semibold text-ink">The weekly rota</h2>
          <ul className="mt-3 divide-y divide-line">
            {shifts.map((shift) => (
              <li key={shift.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-base text-ink">
                  {shift.fullName}
                </span>
                <span className="text-sm text-ink-muted">
                  {shift.shiftDate ??
                    WEEKDAYS.find((w) => w.value === shift.weekday)?.label ??
                    '—'}
                </span>
                <span className="w-32 text-right text-sm text-ink">
                  {shift.startTime}–{shift.endTime}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  aria-label={`Remove ${shift.fullName}'s shift`}
                  onClick={async () => {
                    setBusy(true);
                    await send('/api/v1/staff/shifts', 'DELETE', { shiftId: shift.id });
                    setBusy(false);
                    startTransition(() => router.refresh());
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
