'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Settings {
  isEnabled: boolean;
  isVerified: boolean;
  isLiveMode: boolean;
  keyId: string | null;
  secretHint: string | null;
  webhookSecretHint: string | null;
  webhookUrl: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  encryptionAvailable: boolean;
}

/**
 * The connect form.
 *
 * The secret fields are deliberately empty on every load, even when a secret
 * is stored: there is no code path that sends one back to a browser, and an
 * input pre-filled with asterisks invites somebody to think they can read it.
 * The hint — last four characters — is enough to tell "nothing saved" from
 * "something saved".
 */
export function GatewayPanel({
  initial,
  canEdit,
}: {
  initial: Settings;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);

    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/v1/org/gateway', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        keyId: String(form.get('keyId') ?? '').trim(),
        keySecret: String(form.get('keySecret') ?? ''),
        webhookSecret: String(form.get('webhookSecret') ?? ''),
      }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'Those credentials could not be saved.');
      router.refresh();
      return;
    }

    setSettings(payload.data);
    setDone('Connected. Razorpay accepted those credentials.');
    router.refresh();
  }

  async function toggle(isEnabled: boolean) {
    setBusy(true);
    setError(null);

    const response = await fetch('/api/v1/org/gateway', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isEnabled }),
    });

    setBusy(false);
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      setError(payload?.error?.message ?? 'That could not be changed.');
      return;
    }

    setSettings(payload.data);
    setDone(isEnabled ? 'Online payments are on.' : 'Online payments are off.');
    router.refresh();
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Razorpay</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {settings.isVerified
              ? `Connected as ${settings.keyId} · ${settings.isLiveMode ? 'live' : 'test'} mode`
              : 'Not connected yet.'}
          </p>
        </div>

        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
            settings.isEnabled
              ? 'bg-accent-soft text-accent'
              : settings.isVerified
                ? 'bg-surface-muted text-ink-muted'
                : 'bg-warning/10 text-warning'
          }`}
        >
          {settings.isEnabled ? 'On' : settings.isVerified ? 'Off' : 'Not connected'}
        </span>
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

      {settings.isVerified && canEdit && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => toggle(!settings.isEnabled)}
            className={settings.isEnabled ? 'btn-secondary' : 'btn-primary'}
          >
            {settings.isEnabled ? 'Switch off online payments' : 'Switch on online payments'}
          </button>
          <p className="text-sm text-ink-muted">
            Switching off leaves your credentials saved and stops offering the Pay button.
          </p>
        </div>
      )}

      {settings.webhookUrl && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="label">Your webhook URL</p>
          <p className="mt-1 text-sm text-ink-muted">
            Paste this into Razorpay &rarr; Settings &rarr; Webhooks, with the same webhook
            secret, and subscribe to <code>payment.captured</code> and{' '}
            <code>payment.failed</code>. This is how a payment actually gets recorded.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-control bg-canvas px-3 py-2 text-sm text-ink">
              {settings.webhookUrl}
            </code>
            <button
              type="button"
              className="btn-secondary shrink-0"
              onClick={() => {
                void navigator.clipboard?.writeText(settings.webhookUrl!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {canEdit && settings.encryptionAvailable && (
        <form onSubmit={submit} className="mt-4 space-y-4 border-t border-line pt-4" noValidate>
          <div>
            <label htmlFor="keyId" className="label">
              Key ID
            </label>
            <input
              id="keyId"
              name="keyId"
              required
              defaultValue={settings.keyId ?? ''}
              placeholder="rzp_test_XXXXXXXXXXXX"
              autoComplete="off"
              className="input mt-1.5"
            />
          </div>

          <div>
            <label htmlFor="keySecret" className="label">
              Key secret
              {settings.secretHint && (
                <span className="ml-2 font-normal text-ink-subtle">
                  saved, ending {settings.secretHint}
                </span>
              )}
            </label>
            <input
              id="keySecret"
              name="keySecret"
              type="password"
              required
              autoComplete="new-password"
              placeholder={settings.secretHint ? 'Enter it again to replace' : ''}
              className="input mt-1.5"
            />
          </div>

          <div>
            <label htmlFor="webhookSecret" className="label">
              Webhook secret
              {settings.webhookSecretHint && (
                <span className="ml-2 font-normal text-ink-subtle">
                  saved, ending {settings.webhookSecretHint}
                </span>
              )}
            </label>
            <input
              id="webhookSecret"
              name="webhookSecret"
              type="password"
              required
              autoComplete="new-password"
              className="input mt-1.5"
            />
            <p className="mt-1 text-sm text-ink-subtle">
              You choose this one. Set the same value in Razorpay&rsquo;s webhook settings.
            </p>
          </div>

          <button type="submit" disabled={busy} className="btn-primary">
            {busy ? 'Checking with Razorpay…' : 'Connect'}
          </button>
          <p className="text-sm text-ink-subtle">
            We check these against Razorpay before saving them as connected — by reading your
            account, never by taking a payment. Nothing is switched on until that check
            passes.
          </p>
        </form>
      )}

      {!canEdit && (
        <p className="mt-4 border-t border-line pt-4 text-sm text-ink-muted">
          Your owner can connect this under Settings.
        </p>
      )}
    </section>
  );
}
