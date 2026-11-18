'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * The date range, and the downloads.
 *
 * The files are built from the same services as the page, so the two cannot
 * disagree — which is the only reason a download is worth having.
 */

const PRESETS = [
  { label: 'This month', months: 0 },
  { label: 'Last month', months: 1 },
] as const;

function monthRange(monthsAgo: number): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const end =
    monthsAgo === 0 ? now : new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: iso(start), to: iso(end) };
}

export function ReportControls({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const go = (next: { from: string; to: string }) =>
    startTransition(() =>
      router.replace(`/reports?from=${next.from}&to=${next.to}`),
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        className="input max-w-[11rem]"
        aria-label="From"
        value={from}
        onChange={(event) => event.target.value && go({ from: event.target.value, to })}
      />
      <input
        type="date"
        className="input max-w-[11rem]"
        aria-label="To"
        value={to}
        onChange={(event) => event.target.value && go({ from, to: event.target.value })}
      />

      {PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className="btn-secondary"
          onClick={() => go(monthRange(preset.months))}
        >
          {preset.label}
        </button>
      ))}

      <span className="flex-1" />

      {[
        { kind: 'tax', label: 'GST summary' },
        { kind: 'collections', label: 'Collections' },
        { kind: 'dues', label: 'What is owed' },
      ].map((download) => (
        <a
          key={download.kind}
          className="btn-secondary"
          href={`/api/v1/reports/export?kind=${download.kind}&from=${from}&to=${to}`}
          download
        >
          {download.label} CSV
        </a>
      ))}
    </div>
  );
}
