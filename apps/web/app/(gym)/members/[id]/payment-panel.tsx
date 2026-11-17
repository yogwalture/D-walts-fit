'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Taking money against an outstanding balance.
 *
 * The amount is validated server-side against what is actually due — this
 * form cannot talk the ledger into accepting more than the invoice owes, and
 * the receipt number comes from the gym's own gapless sequence.
 */

const METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card machine' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
] as const;

const rupees = (value: string | number): string =>
  `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function TakePaymentPanel({
  memberId,
  outstanding,
}: {
  memberId: string;
  outstanding: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(outstanding);
  const [method, setMethod] = useState<string>('CASH');
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setSubmitting(true);

    const response = await fetch('/api/v1/finance/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId,
        amount,
        method,
        referenceNumber: reference.trim() || undefined,
      }),
    });

    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'The payment was not recorded. Nothing was taken.');
      return;
    }

    setReceipt(payload.data.receiptCode);
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (receipt) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <p className="text-base text-emerald-900">
          Received. Receipt <span className="font-medium tabular-nums">{receipt}</span>.
        </p>
        <button type="button" className="btn-ghost" onClick={() => setReceipt(null)}>
          Take another
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 className="text-base font-semibold text-ink">
            {rupees(outstanding)} outstanding
          </h2>
          <p className="mt-0.5 text-base text-ink-muted">Record a payment against the balance.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          Take payment
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" className="card space-y-4 p-5" noValidate>
      <h2 className="text-base font-semibold text-ink">Take payment</h2>

      {message && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="pay-amount" className="block text-sm font-medium text-ink">
            Amount
          </label>
          <input
            id="pay-amount"
            className="input mt-1 tabular-nums"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
          <p className="mt-1 text-sm text-ink-subtle">{rupees(outstanding)} due</p>
        </div>

        <div>
          <label htmlFor="pay-method" className="block text-sm font-medium text-ink">
            How
          </label>
          <select
            id="pay-method"
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
          <label htmlFor="pay-reference" className="block text-sm font-medium text-ink">
            Reference
          </label>
          <input
            id="pay-reference"
            className="input mt-1"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="UPI or cheque number"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Recording…' : `Record ${rupees(amount || 0)}`}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
