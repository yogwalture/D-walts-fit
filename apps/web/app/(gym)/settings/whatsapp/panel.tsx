'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Connecting WhatsApp.
 *
 * Saving checks the credentials by reading the gym's own number back from
 * Meta — a read, never a send, because verifying a connection should not
 * message anybody. The connection is only switched on if that read works,
 * so "connected" on this screen means it has actually worked once.
 */
export function WhatsappPanel({
  connected,
  hasToken,
  phoneNumberId,
  disabled,
}: {
  connected: boolean;
  hasToken: boolean;
  phoneNumberId: string | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    setBusy(true);
    setMessage(null);

    const response = await fetch('/api/v1/comms/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wabaId: text('wabaId'),
        phoneNumberId: text('phoneNumberId'),
        accessToken: text('accessToken'),
        businessName: text('businessName'),
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setVerified(false);
      setMessage(payload?.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }

    setVerified(payload?.data?.verified ?? false);
    setMessage(payload?.data?.message ?? null);
    startTransition(() => router.refresh());
  }

  async function disconnect() {
    setBusy(true);
    await fetch('/api/v1/comms/whatsapp', { method: 'DELETE' });
    setBusy(false);
    setMessage('Disconnected, and the stored token was deleted.');
    setVerified(null);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            {connected ? 'Update the connection' : 'Connect WhatsApp'}
          </button>
          {hasToken && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>
        {message && (
          <p
            className={`rounded-control px-3 py-2 text-sm ${
              verified === false
                ? 'border border-warning/30 bg-warning/5 text-ink'
                : 'border border-line bg-canvas text-ink'
            }`}
          >
            {message}
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {message && (
        <div
          role="alert"
          className={`rounded-control px-3 py-2 text-sm ${
            verified === false
              ? 'border border-warning/30 bg-warning/5 text-ink'
              : 'border border-line bg-canvas text-ink'
          }`}
        >
          {message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="phoneNumberId" className="mb-1 block text-sm font-medium text-ink">
            Phone number ID
          </label>
          <input
            id="phoneNumberId"
            name="phoneNumberId"
            className="input"
            defaultValue={phoneNumberId ?? ''}
            placeholder="From Meta’s WhatsApp settings"
            required
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="wabaId" className="mb-1 block text-sm font-medium text-ink">
            Business account ID
          </label>
          <input id="wabaId" name="wabaId" className="input" placeholder="Optional" />
        </div>
      </div>

      <div>
        <label htmlFor="accessToken" className="mb-1 block text-sm font-medium text-ink">
          Access token
        </label>
        <input
          id="accessToken"
          name="accessToken"
          type="password"
          autoComplete="off"
          className="input"
          placeholder={hasToken ? 'Leave blank to keep the stored one' : 'Paste the token'}
        />
        <p className="mt-1 text-sm text-ink-subtle">
          Stored encrypted and never shown again — only its last four characters. Saving checks it
          against WhatsApp straight away by reading your number back; nothing is messaged.
        </p>
      </div>

      <div>
        <label htmlFor="businessName" className="mb-1 block text-sm font-medium text-ink">
          Business name
        </label>
        <input id="businessName" name="businessName" className="input" placeholder="Optional" />
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Checking with WhatsApp…' : 'Save and verify'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
