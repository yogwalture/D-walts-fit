'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/**
 * Search and filter for the members list.
 *
 * Both go into the URL, so the server does the filtering. Searching 4,000
 * members in the browser would mean shipping 4,000 members to the browser.
 *
 * The search is debounced because reception types fast and each keystroke
 * would otherwise be a query — and on shared hosting, an entry process.
 */

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'expiring', label: 'Expiring' },
  { value: 'expired', label: 'Expired' },
  { value: 'unpaid', label: 'Owes money' },
  { value: 'inactive', label: 'Inactive' },
] as const;

export function MemberFilters({ filter, search }: { filter: string; search: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [term, setTerm] = useState(search);

  // Keep the box in step when the user navigates back to a different query.
  useEffect(() => setTerm(search), [search]);

  useEffect(() => {
    if (term === search) return;

    const timer = setTimeout(() => {
      const query = new URLSearchParams({ filter });
      if (term.trim()) query.set('q', term.trim());
      startTransition(() => router.replace(`/members?${query}`));
    }, 300);

    return () => clearTimeout(timer);
  }, [term, search, filter, router]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        className="input max-w-xs"
        placeholder="Name, code or phone"
        aria-label="Search members"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
      />

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter members">
        {FILTERS.map((option) => {
          const query = new URLSearchParams({ filter: option.value });
          if (term.trim()) query.set('q', term.trim());
          const active = option.value === filter;

          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => startTransition(() => router.replace(`/members?${query}`))}
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
      </div>
    </div>
  );
}
