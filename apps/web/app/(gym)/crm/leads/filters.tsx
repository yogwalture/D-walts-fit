'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

const FILTERS = [
  // Overdue first, because that is the list a gym should work from.
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'open', label: 'Open' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'converted', label: 'Joined' },
  { value: 'lost', label: 'Lost' },
  { value: 'all', label: 'All' },
] as const;

export function LeadFilters({ filter, search }: { filter: string; search: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [term, setTerm] = useState(search);

  useEffect(() => setTerm(search), [search]);

  useEffect(() => {
    if (term === search) return;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ filter });
      if (term.trim()) query.set('q', term.trim());
      startTransition(() => router.replace(`/crm/leads?${query}`));
    }, 300);
    return () => clearTimeout(timer);
  }, [term, search, filter, router]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        className="input max-w-xs"
        placeholder="Name, phone or email"
        aria-label="Search enquiries"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter enquiries">
        {FILTERS.map((option) => {
          const query = new URLSearchParams({ filter: option.value });
          if (term.trim()) query.set('q', term.trim());
          const active = option.value === filter;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => startTransition(() => router.replace(`/crm/leads?${query}`))}
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
