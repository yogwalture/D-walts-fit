'use client';

import { useState } from 'react';

/**
 * A member's own copy of their own records.
 *
 * India's DPDP Act gives a person the right to a copy of what an
 * organisation holds about them. A gym running on this software should be
 * able to honour that without emailing us and without a form — so it is a
 * button on the member's own screen, and it includes the medical note the
 * gym's bulk export deliberately leaves out.
 */
export function MyDataButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/portal/export', { method: 'POST' });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? 'That could not be built just now.');
        return;
      }

      const disposition = response.headers.get('content-disposition') ?? '';
      const named = /filename="([^"]+)"/.exec(disposition);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = named?.[1] ?? 'my-data.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('The download was interrupted. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={download} disabled={busy} className="btn-secondary w-full">
        {busy ? 'Preparing…' : 'Download my data'}
      </button>
      <p className="mt-2 text-sm text-ink-muted">
        Your details, visits, payments, bookings and health declaration, as spreadsheets. Yours
        to keep whether or not you stay a member here.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
