'use client';

import { useState } from 'react';

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    const response = await fetch('/api/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }
    setSent(true);
  }

  // The same confirmation whether or not the address has an account: this
  // form must not become a way of asking who has one.
  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <span aria-hidden>✓</span>
        </div>
        <p className="text-base text-ink">Check your inbox.</p>
        <p className="mt-1 text-base text-ink-muted">
          If that address has an account, a reset link is on its way. It expires in 30 minutes.
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
        <label htmlFor="email" className="label">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          className="input mt-1.5"
        />
      </div>

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
