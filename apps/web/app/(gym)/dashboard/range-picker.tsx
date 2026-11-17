'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * The dashboard's date filter.
 *
 * It writes the choice into the URL rather than component state, so the
 * range survives a refresh, can be bookmarked, and is what the server reads
 * when it recounts — no client-side recalculation of anything.
 */

const OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'thisFinancialYear', label: 'This financial year' },
] as const;

export function RangePicker({ current }: { current: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      <span className="sr-only sm:not-sr-only">Showing</span>
      <select
        className="input w-auto py-1.5"
        value={current}
        disabled={isPending}
        onChange={(event) => {
          const value = event.target.value;
          startTransition(() => router.replace(`/dashboard?range=${value}`));
        }}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
