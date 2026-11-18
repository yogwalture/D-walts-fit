'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Recording a spend.
 *
 * Cost and tax are separate boxes because that is how a supplier's bill
 * reads, and because input tax credit is claimed on the tax — folding them
 * into one number throws away the only part an accountant needs.
 */

const METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CARD', label: 'Card' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'OTHER', label: 'Other' },
] as const;

const rupees = (value: string | number): string =>
  `₹${Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function NewExpensePanel({
  categories,
  today,
}: {
  categories: Array<{ id: string; name: string }>;
  today: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const total = Number(amount || 0) + Number(tax || 0);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const response = await fetch('/api/v1/finance/expenses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: text('title'),
        categoryId: text('categoryId'),
        amount: amount.trim(),
        taxAmount: tax.trim() || undefined,
        spentOn: text('spentOn'),
        method: text('method'),
        referenceNumber: text('referenceNumber'),
        description: text('description'),
        isRecurring: form.get('isRecurring') === 'on',
      }),
    });

    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      const error = payload?.error;
      if (error?.details?.length) {
        setFieldErrors(
          Object.fromEntries(
            error.details.map((d: { field: string; issue: string }) => [d.field, d.issue]),
          ),
        );
      }
      setMessage(error?.message ?? 'That was not recorded.');
      return;
    }

    setOpen(false);
    setAmount('');
    setTax('');
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          Record an expense
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" className="card space-y-4 p-5" noValidate>
      <h2 className="text-base font-semibold text-ink">Record an expense</h2>

      {message && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="exp-title" className="block text-sm font-medium text-ink">
            What was it for<span className="text-rose-600"> *</span>
          </label>
          <input
            id="exp-title"
            name="title"
            className="input mt-1"
            placeholder="Shop rent — November"
            autoFocus
            required
            aria-invalid={fieldErrors.title ? true : undefined}
          />
          {fieldErrors.title && <p className="mt-1 text-sm text-rose-700">{fieldErrors.title}</p>}
        </div>

        <div>
          <label htmlFor="exp-category" className="block text-sm font-medium text-ink">
            Category
          </label>
          <select id="exp-category" name="categoryId" className="input mt-1">
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <label htmlFor="exp-amount" className="block text-sm font-medium text-ink">
            Amount<span className="text-rose-600"> *</span>
          </label>
          <input
            id="exp-amount"
            className="input mt-1 tabular-nums"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
          <p className="mt-1 text-sm text-ink-subtle">Before tax</p>
        </div>

        <div>
          <label htmlFor="exp-tax" className="block text-sm font-medium text-ink">
            Tax
          </label>
          <input
            id="exp-tax"
            className="input mt-1 tabular-nums"
            inputMode="decimal"
            value={tax}
            onChange={(event) => setTax(event.target.value)}
            placeholder="0.00"
          />
          <p className="mt-1 text-sm text-ink-subtle">GST on the bill</p>
        </div>

        <div>
          <label htmlFor="exp-date" className="block text-sm font-medium text-ink">
            When<span className="text-rose-600"> *</span>
          </label>
          <input
            id="exp-date"
            name="spentOn"
            type="date"
            className="input mt-1"
            defaultValue={today}
            required
          />
        </div>

        <div>
          <label htmlFor="exp-method" className="block text-sm font-medium text-ink">
            Paid by
          </label>
          <select id="exp-method" name="method" className="input mt-1" defaultValue="CASH">
            {METHODS.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="exp-reference" className="block text-sm font-medium text-ink">
            Reference
          </label>
          <input
            id="exp-reference"
            name="referenceNumber"
            className="input mt-1"
            placeholder="Bill or transfer number"
          />
        </div>
        <div>
          <label htmlFor="exp-notes" className="block text-sm font-medium text-ink">
            Notes
          </label>
          <input id="exp-notes" name="description" className="input mt-1" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-base text-ink">
        <input type="checkbox" name="isRecurring" />
        This happens every month
      </label>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={submitting || !amount.trim()}>
          {submitting ? 'Recording…' : `Record ${rupees(total)}`}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
