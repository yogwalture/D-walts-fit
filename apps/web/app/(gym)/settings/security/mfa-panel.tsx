'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Stage = 'idle' | 'scanning' | 'codes';

/**
 * Two-factor enrolment, in two steps.
 *
 * The secret is shown but nothing is switched on until a code from it
 * verifies. A mistyped or half-scanned setup that silently enabled itself
 * would lock someone out of their own gym.
 */
export function MfaPanel({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  async function begin() {
    setBusy(true);
    setError(null);
    const response = await fetch('/api/v1/me/mfa', { method: 'POST' });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Could not start setup.');
      return;
    }
    setSecret(payload.data.secret);
    setUri(payload.data.uri);
    setStage('scanning');
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const totp = String(new FormData(event.currentTarget).get('totp') ?? '');
    const response = await fetch('/api/v1/me/mfa', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totp }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'That code is not correct.');
      return;
    }

    setRecoveryCodes(payload.data.recoveryCodes);
    setStage('codes');
    router.refresh();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    const response = await fetch('/api/v1/me/mfa', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Could not switch it off.');
      return;
    }
    router.refresh();
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Two-factor authentication</h2>
          <p className="mt-1 text-base text-ink-muted">
            A six-digit code from your phone, on top of your password.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            enabled ? 'bg-accent-soft text-accent' : 'bg-surface-muted text-ink-muted'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {error}
        </div>
      )}

      {stage === 'codes' && (
        <div className="mt-4 space-y-3">
          <p className="text-base text-ink">
            Two-factor authentication is on. Save these recovery codes now.
          </p>
          <ul className="grid grid-cols-2 gap-2 rounded-control bg-surface-muted p-3 font-mono text-sm text-ink">
            {recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <p className="text-sm text-ink-muted">
            Each works once, and they cannot be shown again. They are stored hashed, so nobody —
            including us — can read them back.
          </p>
          <button type="button" className="btn-secondary" onClick={() => setStage('idle')}>
            I have saved them
          </button>
        </div>
      )}

      {stage === 'scanning' && secret && (
        <form method="post" onSubmit={confirm} className="mt-4 space-y-4" noValidate>
          <div>
            <p className="text-base text-ink">
              Add this to your authenticator app, then enter the code it shows.
            </p>
            <code className="mt-2 block break-all rounded-control bg-surface-muted px-3 py-2 font-mono text-sm text-ink">
              {secret}
            </code>
            {uri && (
              <p className="mt-1 text-sm text-ink-subtle">
                Most apps can also scan this as a QR code during setup.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="totp" className="label">
              Code from your app
            </label>
            <input
              id="totp"
              name="totp"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              className="input mt-1.5 text-center font-mono text-lg tracking-[0.4em]"
              placeholder="000000"
            />
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="btn-primary">
              {busy ? 'Checking…' : 'Turn it on'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setStage('idle')}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {stage === 'idle' && !enabled && (
        <button type="button" onClick={begin} disabled={busy} className="btn-primary mt-4">
          {busy ? 'Starting…' : 'Set it up'}
        </button>
      )}

      {stage === 'idle' && enabled && (
        <form method="post" onSubmit={disable} className="mt-4 space-y-3" noValidate>
          <div>
            <label htmlFor="password" className="label">
              Confirm your password to switch it off
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="input mt-1.5 max-w-xs"
            />
          </div>
          <button type="submit" disabled={busy} className="btn-secondary">
            {busy ? 'Switching off…' : 'Turn off two-factor'}
          </button>
        </form>
      )}
    </section>
  );
}
