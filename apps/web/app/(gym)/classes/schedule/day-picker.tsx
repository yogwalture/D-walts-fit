'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * Day navigation.
 *
 * Built from local date parts rather than toISOString, which would give the
 * server's UTC date — yesterday, for the five and a half hours after
 * midnight in India.
 */
function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shift(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return localIso(date);
}

export function DayPicker({ day }: { day: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const go = (next: string) =>
    startTransition(() => router.replace(`/classes/schedule?day=${next}`));

  const [y, m, d] = day.split('-').map(Number);
  const asDate = new Date(y!, (m ?? 1) - 1, d ?? 1);
  const label = asDate.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn-secondary" onClick={() => go(shift(day, -1))}>
        ← Previous
      </button>
      <button type="button" className="btn-secondary" onClick={() => go(localIso(new Date()))}>
        Today
      </button>
      <button type="button" className="btn-secondary" onClick={() => go(shift(day, 1))}>
        Next →
      </button>

      <input
        type="date"
        className="input max-w-[11rem]"
        aria-label="Show another day"
        value={day}
        onChange={(event) => event.target.value && go(event.target.value)}
      />

      <span className="text-base font-medium text-ink">{label}</span>
    </div>
  );
}
