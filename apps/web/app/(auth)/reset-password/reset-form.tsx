'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

export function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  if (!token) {
    return (
      <p className="text-base text-ink-muted">
        This link is missing its token. Request a new reset link and use the one in the email.
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');

    if (password !== confirm) {
      setBusy(false);
      setError('Those two passwords do not match.');
      return;
    }

    const response = await fetch('/api/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }

    setDone(payload?.data?.sessionsRevoked ?? 0);
    setTimeout(() => router.replace('/login'), 2500);
  }

  if (done !== null) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <span aria-hidden>✓</span>
        </div>
        <p className="text-base text-ink">Your password has been changed.</p>
        <p className="mt-1 text-base text-ink-muted">
          {done > 0
            ? `${done} other ${done === 1 ? 'session was' : 'sessions were'} signed out. Taking you to sign in…`
            : 'Taking you to sign in…'}
        </p>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && (
        <div
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {error}
        </div>
      )}

      <div>
        <label htmlFor="password" className="label">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          autoFocus
          className="input mt-1.5"
          aria-describedby="hint"
        />
        <p id="hint" className="mt-1 text-sm text-ink-subtle">
          At least 8 characters.
        </p>
      </div>

      <div>
        <label htmlFor="confirm" className="label">
          Confirm new password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="input mt-1.5"
        />
      </div>

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}
