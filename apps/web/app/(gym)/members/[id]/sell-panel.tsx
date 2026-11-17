'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

/**
 * Selling a membership at the counter.
 *
 * The total is never computed here. Picking a plan asks the server to quote
 * it, and the figure shown is the same function the sale itself uses — so
 * what the member is told and what the invoice says cannot disagree, whatever
 * the tax rate or the rounding.
 */

interface Plan {
  id: string;
  name: string;
  price: string;
  duration: string;
}

interface Quote {
  total: string;
  taxable: string;
  tax: string;
  endDate: string;
  startDate: string;
  durationLabel: string;
}

const METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card machine' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
] as const;

const rupees = (value: string | number): string =>
  `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SellMembershipPanel({
  memberId,
  memberName,
  plans,
  isRenewal,
  renewalFrom,
}: {
  memberId: string;
  memberName: string;
  plans: Plan[];
  isRenewal: boolean;
  renewalFrom: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [collectNow, setCollectNow] = useState(true);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('CASH');
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --- the server quotes; the browser only displays -----------------------
  useEffect(() => {
    if (!planId) {
      setQuote(null);
      return;
    }

    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(
          `/api/v1/memberships/quote?planId=${encodeURIComponent(planId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setQuote(null);
          return;
        }
        const payload = await response.json();
        setQuote(payload.data);
        setAmount(payload.data.total);
      } catch {
        // Aborted by the next selection.
      }
    })();

    return () => controller.abort();
  }, [planId]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setSubmitting(true);

    const response = await fetch('/api/v1/memberships/sell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId,
        planId,
        payment: collectNow
          ? {
              amount,
              method,
              referenceNumber: reference.trim() || undefined,
            }
          : undefined,
      }),
    });

    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'The sale did not go through. Nothing was charged.');
      return;
    }

    setOpen(false);
    setPlanId('');
    setQuote(null);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="text-base font-semibold text-ink">
            {isRenewal ? 'Renew membership' : 'Sell a membership'}
          </h2>
          <p className="mt-0.5 text-base text-ink-muted">
            {isRenewal && renewalFrom
              ? `New term starts the day after ${renewalFrom} — no days are lost.`
              : `Pick a plan and take payment in one step.`}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          {isRenewal ? 'Renew' : 'Sell membership'}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" className="card space-y-4 p-5" noValidate>
      <h2 className="text-base font-semibold text-ink">
        {isRenewal ? `Renew for ${memberName}` : `Sell a membership to ${memberName}`}
      </h2>

      {message && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <div>
        <label htmlFor="plan" className="block text-sm font-medium text-ink">
          Plan
        </label>
        <select
          id="plan"
          className="input mt-1"
          value={planId}
          onChange={(event) => setPlanId(event.target.value)}
          required
        >
          <option value="">Choose a plan…</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} — {rupees(plan.price)} / {plan.duration}
            </option>
          ))}
        </select>
      </div>

      {quote && (
        <dl className="rounded-control bg-canvas p-3.5 text-base">
          <div className="flex justify-between py-0.5">
            <dt className="text-ink-muted">Before tax</dt>
            <dd className="tabular-nums text-ink">{rupees(quote.taxable)}</dd>
          </div>
          <div className="flex justify-between py-0.5">
            <dt className="text-ink-muted">Tax</dt>
            <dd className="tabular-nums text-ink">{rupees(quote.tax)}</dd>
          </div>
          <div className="mt-1.5 flex justify-between border-t border-line pt-1.5 font-semibold">
            <dt className="text-ink">Total</dt>
            <dd className="tabular-nums text-ink">{rupees(quote.total)}</dd>
          </div>
          <p className="mt-2 text-sm text-ink-muted">
            Runs {quote.durationLabel}, until{' '}
            {new Intl.DateTimeFormat('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(new Date(quote.endDate))}
            . That last day is included.
          </p>
        </dl>
      )}

      <label className="flex items-center gap-2 text-base text-ink">
        <input
          type="checkbox"
          checked={collectNow}
          onChange={(event) => setCollectNow(event.target.checked)}
        />
        Taking payment now
      </label>

      {collectNow && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-ink">
              Amount
            </label>
            <input
              id="amount"
              className="input mt-1 tabular-nums"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
            <p className="mt-1 text-sm text-ink-subtle">Part payment is fine.</p>
          </div>

          <div>
            <label htmlFor="method" className="block text-sm font-medium text-ink">
              How
            </label>
            <select
              id="method"
              className="input mt-1"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            >
              {METHODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="reference" className="block text-sm font-medium text-ink">
              Reference
            </label>
            <input
              id="reference"
              className="input mt-1"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="UPI or cheque number"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={!planId || submitting}>
          {submitting
            ? 'Recording…'
            : collectNow && quote
              ? `Take ${rupees(amount || quote.total)}`
              : 'Create membership'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setOpen(false);
            setMessage(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
