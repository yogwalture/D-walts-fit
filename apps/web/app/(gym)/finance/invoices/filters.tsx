'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'ISSUED', label: 'Unpaid' },
  { value: 'PARTIALLY_PAID', label: 'Part paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'CANCELLED', label: 'Cancelled' },
] as const;

/** Search and status in the URL, so the view can be bookmarked and shared. */
export function InvoiceFilters({ status, search }: { status: string; search: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [term, setTerm] = useState(search);

  useEffect(() => setTerm(search), [search]);

  useEffect(() => {
    if (term === search) return;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ status });
      if (term.trim()) query.set('q', term.trim());
      startTransition(() => router.replace(`/finance/invoices?${query}`));
    }, 300);
    return () => clearTimeout(timer);
  }, [term, search, status, router]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        className="input max-w-xs"
        placeholder="Invoice number or member"
        aria-label="Search invoices"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter invoices">
        {STATUSES.map((option) => {
          const query = new URLSearchParams({ status: option.value });
          if (term.trim()) query.set('q', term.trim());
          const active = option.value === status;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => startTransition(() => router.replace(`/finance/invoices?${query}`))}
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
