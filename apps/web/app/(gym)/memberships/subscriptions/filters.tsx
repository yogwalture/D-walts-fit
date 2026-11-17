'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

const STATUSES = [
  // "Live" is the default because it is the question a gym actually asks:
  // which memberships do we still owe service on? A frozen one still counts,
  // so freezing a membership does not make its row disappear mid-conversation.
  { value: 'live', label: 'Live' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'FROZEN', label: 'Frozen' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'all', label: 'All' },
] as const;

export function SubscriptionFilters({
  status,
  search,
  expiring,
}: {
  status: string;
  search: string;
  expiring: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [term, setTerm] = useState(search);

  useEffect(() => setTerm(search), [search]);

  const go = (next: URLSearchParams) => {
    if (term.trim()) next.set('q', term.trim());
    startTransition(() => router.replace(`/memberships/subscriptions?${next}`));
  };

  useEffect(() => {
    if (term === search) return;
    const timer = setTimeout(() => {
      const query = new URLSearchParams(expiring ? { expiring: '1' } : { status });
      if (term.trim()) query.set('q', term.trim());
      startTransition(() => router.replace(`/memberships/subscriptions?${query}`));
    }, 300);
    return () => clearTimeout(timer);
  }, [term, search, status, expiring, router]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        className="input max-w-xs"
        placeholder="Name, code or phone"
        aria-label="Search memberships"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
      />

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter memberships">
        {STATUSES.map((option) => {
          const active = !expiring && option.value === status;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => go(new URLSearchParams({ status: option.value }))}
              className={
                active
                  ? 'rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-white'
                  : 'rounded-control border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-canvas'
              }
            >
              {option.label}
            </button>
          );
        })}

        {/* The view a gym opens on a Monday morning. */}
        <button
          type="button"
          aria-pressed={expiring}
          onClick={() => go(new URLSearchParams({ expiring: '1' }))}
          className={
            expiring
              ? 'rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-white'
              : 'rounded-control border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-canvas'
          }
        >
          Expiring in 14 days
        </button>
      </div>
    </div>
  );
}
