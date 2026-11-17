'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Creating a plan.
 *
 * The grace period and freeze allowance are on this form rather than buried
 * in settings, because they are the terms a gym argues about at the desk —
 * "my membership ended yesterday, can I still train today" is answered by
 * the number typed here, not by a staff member's judgement.
 */
export interface TaxRateOption {
  id: string;
  name: string;
  percentage: string;
  isDefault: boolean;
}

export function NewPlanPanel({ taxRates }: { taxRates: TaxRateOption[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState('MONTH');
  const [taxRateId, setTaxRateId] = useState(
    taxRates.find((rate) => rate.isDefault)?.id ?? taxRates[0]?.id ?? '',
  );
  const [freezeAllowed, setFreezeAllowed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

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

    const body = {
      name: text('name'),
      description: text('description'),
      durationUnit: unit,
      durationValue: Number(text('durationValue') ?? 1),
      sessionCount: text('sessionCount') ? Number(text('sessionCount')) : undefined,
      price: text('price'),
      taxRateId: taxRateId || undefined,
      priceIncludesTax: form.get('priceIncludesTax') === 'on',
      graceDays: Number(text('graceDays') ?? 0),
      freezeAllowed,
      freezeMaxDays: freezeAllowed ? Number(text('freezeMaxDays') ?? 0) : 0,
      transferAllowed: form.get('transferAllowed') === 'on',
      visibleToMembers: form.get('visibleToMembers') === 'on',
    };

    const response = await fetch('/api/v1/memberships/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
      setMessage(error?.message ?? 'The plan was not created.');
      return;
    }

    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          New plan
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" className="card space-y-4 p-5" noValidate>
      <h2 className="text-base font-semibold text-ink">New plan</h2>

      {message && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          name="name"
          required
          autoFocus
          error={fieldErrors.name}
          placeholder="Monthly, Quarterly, Personal training…"
        />
        <Field label="Description" name="description" placeholder="Shown to members" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="durationUnit" className="block text-sm font-medium text-ink">
            Billed by
          </label>
          <select
            id="durationUnit"
            className="input mt-1"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
          >
            <option value="DAY">Days</option>
            <option value="WEEK">Weeks</option>
            <option value="MONTH">Months</option>
            <option value="YEAR">Years</option>
            <option value="SESSION">Sessions</option>
          </select>
        </div>

        {unit === 'SESSION' ? (
          <Field
            label="How many sessions"
            name="sessionCount"
            inputMode="numeric"
            defaultValue="10"
            required
            error={fieldErrors.sessionCount}
          />
        ) : (
          <Field
            label="How many"
            name="durationValue"
            inputMode="numeric"
            defaultValue="1"
            required
            error={fieldErrors.durationValue}
          />
        )}

        <Field
          label="Price"
          name="price"
          inputMode="decimal"
          required
          error={fieldErrors.price}
          placeholder="1500.00"
        />
      </div>

      {taxRates.length > 0 && (
        <div>
          <label htmlFor="taxRateId" className="block text-sm font-medium text-ink">
            Tax
          </label>
          <select
            id="taxRateId"
            className="input mt-1"
            value={taxRateId}
            onChange={(event) => setTaxRateId(event.target.value)}
          >
            <option value="">No tax</option>
            {taxRates.map((rate) => (
              <option key={rate.id} value={rate.id}>
                {rate.name} ({rate.percentage}%)
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-ink-subtle">
            The invoice shows the split — CGST and SGST separately, as a GST return needs.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Grace period (days)"
          name="graceDays"
          inputMode="numeric"
          defaultValue="0"
          hint="Days a member may still train after expiry"
        />
        {freezeAllowed && (
          <Field
            label="Freeze allowance (days)"
            name="freezeMaxDays"
            inputMode="numeric"
            defaultValue="15"
            hint="Total across the whole membership"
          />
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Terms</legend>
        <Check name="priceIncludesTax" label="Price includes tax" defaultChecked />
        <label className="flex items-center gap-2 text-base text-ink">
          <input
            type="checkbox"
            checked={freezeAllowed}
            onChange={(event) => setFreezeAllowed(event.target.checked)}
          />
          Members may freeze this membership
        </label>
        <Check name="transferAllowed" label="May be transferred" />
        <Check name="visibleToMembers" label="Show in the member app" defaultChecked />
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create plan'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  required,
  autoFocus,
  hint,
  error,
  placeholder,
  defaultValue,
  inputMode,
}: {
  label: string;
  name: string;
  required?: boolean;
  autoFocus?: boolean;
  hint?: string;
  error?: string;
  placeholder?: string;
  defaultValue?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
}) {
  const id = `plan-${name}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required && <span className="text-rose-600"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        defaultValue={defaultValue}
        inputMode={inputMode}
        className="input mt-1"
        aria-invalid={error ? true : undefined}
      />
      {error ? (
        <p className="mt-1 text-sm text-rose-700">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-sm text-ink-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

function Check({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-base text-ink">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      {label}
    </label>
  );
}
