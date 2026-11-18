'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Checking in from the member's own phone.
 *
 * The code comes from the QR at the entrance, which rotates — so a member
 * cannot check in from the car park, and a screenshot taken last week is
 * worthless. The rules are the door's own: a membership that would be
 * turned away at the desk is turned away here, with the same words.
 */
export function CheckInPanel() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ allowed: boolean; message: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const raw = String(form.get('code') ?? '').trim();

    // The QR encodes gymcloud:m:<slug>:<token>; a member pasting the whole
    // thing should not have to know that.
    const code = raw.includes(':') ? raw.split(':').pop()! : raw;

    setBusy(true);
    const response = await fetch('/api/v1/me/checkin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setResult({
        allowed: false,
        message: payload?.error?.message ?? 'That code did not work.',
      });
      return;
    }

    setResult({
      allowed: payload?.data?.allowed ?? false,
      message: payload?.data?.message ?? '',
    });
    startTransition(() => router.refresh());
  }

  if (result) {
    return (
      <section
        className={`card p-5 ${result.allowed ? 'border-accent/40' : 'border-warning/40'}`}
      >
        <p className="text-lg font-semibold text-ink">
          {result.allowed ? 'You are in' : 'Not checked in'}
        </p>
        <p className="mt-1 text-base text-ink-muted">{result.message}</p>
        <button
          type="button"
          className="btn-secondary mt-3"
          onClick={() => {
            setResult(null);
            setOpen(false);
          }}
        >
          Done
        </button>
      </section>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn-primary w-full py-3" onClick={() => setOpen(true)}>
        Check in
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-3 p-5" noValidate>
      <div>
        <label htmlFor="code" className="mb-1 block text-sm font-medium text-ink">
          The code at the entrance
        </label>
        <input
          id="code"
          name="code"
          className="input"
          placeholder="Scan or type it"
          required
          autoFocus
          autoComplete="off"
        />
        <p className="mt-1 text-sm text-ink-subtle">
          It changes regularly, so it only works while you are actually at the gym.
        </p>
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Checking in…' : 'Check in'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
