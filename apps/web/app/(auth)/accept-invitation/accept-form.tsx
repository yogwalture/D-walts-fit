'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function AcceptInvitationForm({
  token,
  email,
  invitedName,
}: {
  token: string;
  email: string;
  /** Prefilled from the invitation, and editable: it is their name, not ours. */
  invitedName?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/v1/auth/invitation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        fullName: String(form.get('fullName') ?? ''),
        password: String(form.get('password') ?? ''),
      }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }

    router.replace('/dashboard');
    router.refresh();
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
        <label className="label">Email address</label>
        {/* Fixed to the invitation: changing it here would let anyone holding
            the link claim a different account. */}
        <input value={email} readOnly disabled className="input mt-1.5" />
      </div>

      <div>
        <label htmlFor="fullName" className="label">
          Your name
        </label>
        <input
          id="fullName"
          name="fullName"
          autoComplete="name"
          required
          autoFocus
          defaultValue={invitedName ?? ''}
          className="input mt-1.5"
        />
      </div>

      <div>
        <label htmlFor="password" className="label">
          Choose a password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="input mt-1.5"
          aria-describedby="hint"
        />
        <p id="hint" className="mt-1 text-sm text-ink-subtle">
          At least 12 characters. Nobody else can see it — not even the gym owner.
        </p>
      </div>

      <button type="submit" disabled={busy} className="btn-primary w-full">
        {busy ? 'Joining…' : 'Join the team'}
      </button>
    </form>
  );
}
