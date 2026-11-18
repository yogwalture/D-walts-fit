'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Recording an enquiry.
 *
 * Deliberately short: this gets filled in while someone is standing at the
 * desk asking about prices. A name, a number, and where they came from is
 * enough — everything else can be added when the first call happens.
 */

const SOURCES = [
  { value: 'WALK_IN', label: 'Walked in' },
  { value: 'TELEPHONE', label: 'Phoned' },
  { value: 'REFERRAL', label: 'Referred by a member' },
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'WEBSITE', label: 'Website' },
  { value: 'OTHER', label: 'Somewhere else' },
] as const;

export function NewLeadPanel({ plans }: { plans: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
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

    const response = await fetch('/api/v1/crm/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: text('fullName'),
        phone: text('phone'),
        email: text('email'),
        city: text('city'),
        source: text('source'),
        sourceDetail: text('sourceDetail'),
        interestedPlanId: text('interestedPlanId'),
        budgetNote: text('budgetNote'),
        nextFollowUpAt: text('nextFollowUpAt'),
        notes: text('notes'),
        allowDuplicate,
      }),
    });

    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      const error = payload?.error;
      if (error?.code === 'DUPLICATE_LEAD') {
        setDuplicate(true);
        setMessage(error.message);
        return;
      }
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
    setDuplicate(false);
    setAllowDuplicate(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          Record an enquiry
        </button>
      </div>
    );
  }

  const tomorrow = new Date(Date.now() + 86_400_000);
  const defaultFollowUp = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  return (
    <form onSubmit={onSubmit} method="post" className="card space-y-4 p-5" noValidate>
      <h2 className="text-base font-semibold text-ink">Record an enquiry</h2>

      {message && (
        <div
          role="alert"
          className={`rounded-control px-3.5 py-2.5 text-base ring-1 ring-inset ${
            duplicate
              ? 'bg-amber-50 text-amber-900 ring-amber-200'
              : 'bg-rose-50 text-rose-800 ring-rose-200'
          }`}
        >
          <p>{message}</p>
          {duplicate && (
            <label className="mt-2 flex items-start gap-2 text-base">
              <input
                type="checkbox"
                className="mt-1"
                checked={allowDuplicate}
                onChange={(event) => setAllowDuplicate(event.target.checked)}
              />
              <span>Record it anyway — families and couples often share one number.</span>
            </label>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="fullName" required autoFocus error={fieldErrors.fullName} />
        <Field
          label="Mobile number"
          name="phone"
          required
          inputMode="numeric"
          error={fieldErrors.phone}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="lead-source" className="block text-sm font-medium text-ink">
            How did they find us
          </label>
          <select id="lead-source" name="source" className="input mt-1" defaultValue="WALK_IN">
            {SOURCES.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="lead-plan" className="block text-sm font-medium text-ink">
            Interested in
          </label>
          <select id="lead-plan" name="interestedPlanId" className="input mt-1">
            <option value="">Not sure yet</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Call them back on"
          name="nextFollowUpAt"
          type="date"
          defaultValue={defaultFollowUp}
          hint="Tomorrow by default"
        />
      </div>

      <details className="rounded-control border border-line">
        <summary className="cursor-pointer px-4 py-2.5 text-base font-medium text-ink">
          Email, city and notes
          <span className="ml-2 text-sm font-normal text-ink-muted">optional</span>
        </summary>
        <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
          <Field label="Email" name="email" type="email" error={fieldErrors.email} />
          <Field label="City" name="city" />
          <Field label="Where exactly" name="sourceDetail" hint="Which advert, which member referred them" />
          <Field label="Budget" name="budgetNote" hint="What they said they could spend" />
          <div className="sm:col-span-2">
            <Field label="Notes" name="notes" />
          </div>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="btn-primary"
          disabled={submitting || (duplicate && !allowDuplicate)}
        >
          {submitting ? 'Recording…' : 'Record enquiry'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setOpen(false);
            setMessage(null);
            setDuplicate(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  autoFocus,
  hint,
  error,
  defaultValue,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  hint?: string;
  error?: string;
  defaultValue?: string;
  inputMode?: 'numeric' | 'text';
}) {
  const id = `lead-${name}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required && <span className="text-rose-600"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        autoFocus={autoFocus}
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
