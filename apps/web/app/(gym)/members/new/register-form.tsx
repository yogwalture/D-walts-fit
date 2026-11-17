'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';

/**
 * Member registration.
 *
 * Two names and a phone number are all that is required, because this form
 * is filled in while somebody waits at the desk. Everything else is optional
 * and can be added from the member's profile later.
 *
 * The duplicate check runs as the number is typed, so a collision shows as a
 * warning with a link to the existing member — not as a rejection after the
 * form has been filled in.
 */

interface Duplicate {
  id: string;
  memberCode: string;
  name: string;
  phone: string;
  matchedOn: string;
}

export function RegisterMemberForm({ branches }: { branches: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [phone, setPhone] = useState('');
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- live duplicate check -----------------------------------------------
  useEffect(() => {
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) {
      setDuplicates([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/v1/members/duplicates?phone=${encodeURIComponent(digits)}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const payload = await response.json();
        setDuplicates(Array.isArray(payload?.data) ? payload.data : []);
      } catch {
        // An aborted or failed check must never block registration.
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [phone]);

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
      firstName: text('firstName'),
      lastName: text('lastName'),
      phone: text('phone'),
      email: text('email'),
      dateOfBirth: text('dateOfBirth'),
      gender: text('gender'),
      branchId: text('branchId'),
      occupation: text('occupation'),
      referredBy: text('referredBy'),
      notes: text('notes'),
      // Flat, matching the columns: nesting these is how the address came to
      // be dropped on the way to the server.
      addressLine1: text('addressLine1'),
      city: text('city'),
      state: text('state'),
      postalCode: text('postalCode'),
      emergencyContactName: text('emergencyContactName'),
      emergencyContactPhone: text('emergencyContactPhone'),
      emergencyContactRelation: text('emergencyContactRelation'),
      allowDuplicate: acknowledged,
    };

    const response = await fetch('/api/v1/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      const error = payload?.error;

      if (error?.code === 'DUPLICATE_MEMBER') {
        setMessage('Someone with these details is already registered. Tick the box to add anyway.');
        return;
      }

      if (error?.details?.length) {
        setFieldErrors(
          Object.fromEntries(
            error.details.map((d: { field: string; issue: string }) => [d.field, d.issue]),
          ),
        );
      }
      setMessage(error?.message ?? 'Something went wrong. Please try again.');
      return;
    }

    startTransition(() => {
      router.replace(`/members/${payload.data.id}?welcome=1`);
      router.refresh();
    });
  }

  const busy = submitting || isPending;

  return (
    <form onSubmit={onSubmit} method="post" className="space-y-5" noValidate>
      {message && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <section className="card space-y-4 p-5">
        <h2 className="text-base font-semibold text-ink">Who they are</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" name="firstName" required error={fieldErrors.firstName} autoFocus />
          <Field label="Last name" name="lastName" error={fieldErrors.lastName} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Mobile number"
            name="phone"
            type="tel"
            required
            inputMode="numeric"
            hint="10 digits, no country code"
            error={fieldErrors.phone}
            value={phone}
            onChange={setPhone}
          />
          <Field label="Email" name="email" type="email" error={fieldErrors.email} />
        </div>

        {duplicates.length > 0 && (
          <div className="rounded-control bg-amber-50 p-3.5 ring-1 ring-inset ring-amber-200">
            <p className="text-base font-medium text-amber-900">
              {duplicates.length === 1
                ? 'This number is already on file'
                : `${duplicates.length} members already use this number`}
            </p>
            <ul className="mt-2 space-y-1">
              {duplicates.map((duplicate) => (
                <li key={duplicate.id} className="text-base text-amber-900">
                  <Link href={`/members/${duplicate.id}`} className="font-medium underline">
                    {duplicate.name}
                  </Link>{' '}
                  <span className="tabular-nums text-amber-800">({duplicate.memberCode})</span>
                </li>
              ))}
            </ul>
            <label className="mt-3 flex items-start gap-2 text-base text-amber-900">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                Register anyway — families and couples often share one mobile number.
              </span>
            </label>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date of birth" name="dateOfBirth" type="date" error={fieldErrors.dateOfBirth} />
          <Select
            label="Gender"
            name="gender"
            options={[
              { value: '', label: 'Prefer not to say' },
              { value: 'MALE', label: 'Male' },
              { value: 'FEMALE', label: 'Female' },
              { value: 'OTHER', label: 'Other' },
            ]}
          />
          {branches.length > 1 ? (
            <Select
              label="Branch"
              name="branchId"
              options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
            />
          ) : (
            <Field label="Occupation" name="occupation" />
          )}
        </div>
      </section>

      <details className="card">
        <summary className="cursor-pointer px-5 py-3.5 text-base font-medium text-ink">
          Address, emergency contact and notes
          <span className="ml-2 text-sm font-normal text-ink-muted">optional</span>
        </summary>

        <div className="space-y-4 border-t border-line p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" name="addressLine1" />
            <Field label="City" name="city" />
            <Field label="State" name="state" />
            <Field label="PIN code" name="postalCode" inputMode="numeric" error={fieldErrors.postalCode} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Emergency contact" name="emergencyContactName" />
            <Field
              label="Their number"
              name="emergencyContactPhone"
              type="tel"
              inputMode="numeric"
              error={fieldErrors.emergencyContactPhone}
            />
            <Field label="Relationship" name="emergencyContactRelation" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="How did they hear about us?" name="referredBy" />
            <Field label="Notes" name="notes" />
          </div>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Registering…' : 'Register member'}
        </button>
        <Link href="/members" className="btn-ghost">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  hint,
  error,
  autoFocus,
  inputMode,
  value,
  onChange,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  autoFocus?: boolean;
  inputMode?: 'numeric' | 'text';
  value?: string;
  onChange?: (value: string) => void;
}) {
  const id = `field-${name}`;

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
        inputMode={inputMode}
        className="input mt-1"
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        aria-invalid={error ? true : undefined}
        {...(onChange ? { value, onChange: (e) => onChange(e.target.value) } : {})}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-sm text-rose-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-sm text-ink-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Select({
  label,
  name,
  options,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
}) {
  const id = `field-${name}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <select id={id} name={name} className="input mt-1">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
