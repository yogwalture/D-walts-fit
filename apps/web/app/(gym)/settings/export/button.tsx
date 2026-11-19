'use client';

import { useState } from 'react';

/**
 * The download.
 *
 * `fetch` then an object URL rather than a plain link, because the export is
 * a POST — it writes an audit row, and a GET that large invites a browser to
 * prefetch it and quietly record an export nobody asked for.
 *
 * The honest part is the waiting state: a big gym's archive takes a few
 * seconds to stream, and a button that looks inert is a button somebody
 * presses four times.
 */
export function ExportButton({ rows }: { rows: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/org/export', { method: 'POST' });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? 'That export could not be built.');
        return;
      }

      const disposition = response.headers.get('content-disposition') ?? '';
      const named = /filename="([^"]+)"/.exec(disposition);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = named?.[1] ?? 'gym-export.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Released once the browser has taken it, or the blob stays in memory
      // for as long as the tab is open.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError('The download was interrupted. Nothing was changed — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button type="button" onClick={download} disabled={busy} className="btn-primary">
        {busy ? 'Building your archive…' : 'Download everything'}
      </button>
      <p className="mt-1.5 text-sm text-ink-subtle">
        {busy
          ? 'This can take a few seconds. Keep this tab open.'
          : rows > 50_000
            ? 'A large export — give it a moment once you press it.'
            : 'A ZIP of CSV files.'}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
