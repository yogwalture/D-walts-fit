'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

/**
 * Check-in.
 *
 * Designed around what actually happens at 6 a.m.: one receptionist, forty
 * people, no time to choose a mode first. One box takes a scanned QR token,
 * a member code or a phone number, and the server works out which it is.
 *
 * A refusal is not an error here — it is an answer. The member's name stays
 * on screen with the reason, so the receptionist can say "your membership
 * ended on Tuesday" rather than "the computer says no".
 *
 * The box re-focuses itself after every scan, because a barcode reader types
 * and presses Enter: focus is the whole interface.
 */

interface Result {
  allowed: boolean;
  refusal?: string;
  message: string;
  member: { id: string; memberCode: string; name: string; phone: string };
  membership?: {
    planName: string;
    endDate: string;
    daysRemaining: number;
    inGracePeriod: boolean;
    sessionsRemaining: number | null;
  };
  overrideUsed?: boolean;
}

const REFUSALS_THAT_ALLOW_OVERRIDE = new Set([
  'NO_MEMBERSHIP',
  'EXPIRED',
  'FROZEN',
  'MEMBER_SUSPENDED',
]);

export function CheckInPanel() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, [result]);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);

    const response = await fetch('/api/v1/attendance/check-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setResult(null);
      setError(payload?.error?.message ?? 'Could not check that member in.');
      return;
    }

    setResult(payload.data);
    setTerm('');
    setOverrideReason('');
    startTransition(() => router.refresh());
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = term.trim();
    if (!value) return;

    // A QR token is long and random; a member code is short; anything that is
    // ten digits is a phone number. The server re-derives this itself — this
    // only decides which field to put it in.
    const digits = value.replace(/\D/g, '');
    if (value.length >= 20) {
      void send({ qrToken: value });
    } else if (digits.length === 10 && digits === value) {
      void send({ phone: value });
    } else {
      void send({ memberCode: value });
    }
  }

  function onOverride() {
    if (!result || !overrideReason.trim()) return;
    void send({
      memberId: result.member.id,
      override: true,
      overrideReason: overrideReason.trim(),
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} method="post" className="card p-5" noValidate>
        <label htmlFor="scan" className="block text-sm font-medium text-ink">
          Scan a code, or type a member code or phone number
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="scan"
            ref={inputRef}
            className="input flex-1 text-lg"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="M00042 or 9876543210"
            autoComplete="off"
            enterKeyHint="go"
            disabled={busy}
          />
          <button type="submit" className="btn-primary" disabled={busy || !term.trim()}>
            {busy ? '…' : 'Check in'}
          </button>
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {error}
        </p>
      )}

      {result && (
        <div
          className={`card p-5 ring-1 ${
            result.allowed
              ? 'bg-emerald-50/60 ring-emerald-200'
              : 'bg-amber-50/60 ring-amber-200'
          }`}
          aria-live="polite"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xl font-semibold text-ink">{result.member.name}</p>
              <p className="text-base tabular-nums text-ink-muted">
                {result.member.memberCode} · {result.member.phone}
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-base font-semibold ${
                result.allowed ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white'
              }`}
            >
              {result.allowed ? 'In' : 'Not in'}
            </span>
          </div>

          <p className="mt-3 text-base text-ink">{result.message}</p>

          {result.membership && (
            <p className="mt-1 text-base text-ink-muted">
              {result.membership.planName}
              {result.membership.sessionsRemaining !== null
                ? ` · ${result.membership.sessionsRemaining} sessions left`
                : ` · ${result.membership.daysRemaining} days left`}
            </p>
          )}

          {result.overrideUsed && (
            <p className="mt-2 text-sm font-medium text-amber-800">
              Let in on an override. This is recorded against your name.
            </p>
          )}

          {!result.allowed && REFUSALS_THAT_ALLOW_OVERRIDE.has(result.refusal ?? '') && (
            <div className="mt-4 border-t border-amber-200 pt-4">
              <label htmlFor="override" className="block text-sm font-medium text-ink">
                Let them in anyway — why?
              </label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <input
                  id="override"
                  className="input flex-1"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  placeholder="Paying at the desk in a moment"
                />
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={onOverride}
                  disabled={busy || !overrideReason.trim()}
                >
                  Override
                </button>
              </div>
              <p className="mt-1 text-sm text-ink-subtle">
                Recorded in the audit log with your name and the reason.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
