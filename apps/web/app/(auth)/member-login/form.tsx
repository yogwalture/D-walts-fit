'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Member sign-in: a number and a code.
 *
 * No password, because a member signs in three times a year and would
 * reset it every time. The screen answers identically whether or not the
 * number is registered — a login form must not double as a way to check
 * who belongs to a gym.
 */
export function MemberLoginForm({ gymSlug }: { gymSlug: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [step, setStep] = useState<'identify' | 'code'>('identify');
  const [identifier, setIdentifier] = useState('');
  const [slug, setSlug] = useState(gymSlug);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const response = await fetch('/api/v1/auth/member', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: identifier.trim(), organizationSlug: slug.trim() }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }

    setStep('code');
    setMessage(payload?.data?.message ?? 'If that account exists, a code is on its way.');
  }

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setBusy(true);
    setMessage(null);

    const response = await fetch('/api/v1/auth/member', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: identifier.trim(),
        organizationSlug: slug.trim(),
        code: String(form.get('code') ?? '').trim(),
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'That code did not work.');
      return;
    }

    startTransition(() => {
      router.replace('/my');
      router.refresh();
    });
  }

  if (step === 'code') {
    return (
      <form onSubmit={verify} className="space-y-4" noValidate>
        {message && (
          <p
            role="status"
            className="rounded-control border border-line bg-canvas px-3 py-2 text-sm text-ink"
          >
            {message}
          </p>
        )}

        <div>
          <label htmlFor="code" className="label">
            The six-digit code
          </label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            className="input mt-1.5 text-center text-2xl tracking-[0.4em]"
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>

        <button
          type="button"
          className="btn-ghost w-full"
          onClick={() => {
            setStep('identify');
            setMessage(null);
          }}
        >
          Use a different number
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={requestCode} className="space-y-4" noValidate>
      {message && (
        <p
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {message}
        </p>
      )}

      <div>
        <label htmlFor="gym" className="label">
          Your gym
        </label>
        <input
          id="gym"
          name="gym"
          required
          autoFocus={!gymSlug}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="iron-temple"
          className="input mt-1.5"
        />
        <p className="mt-1 text-sm text-ink-subtle">
          The short name your gym gave you — it is in the link they sent.
        </p>
      </div>

      <div>
        <label htmlFor="identifier" className="label">
          Mobile number
        </label>
        <input
          id="identifier"
          name="identifier"
          inputMode="tel"
          autoComplete="tel"
          required
          autoFocus={Boolean(gymSlug)}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="98765 43210"
          className="input mt-1.5"
        />
      </div>

      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Sending…' : 'Send me a code'}
      </button>
    </form>
  );
}
