'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Editing a member.
 *
 * Only the fields that changed are sent, so two people editing different
 * parts of the same record do not overwrite each other's work — and an empty
 * optional field is left alone rather than being read as "clear this".
 *
 * Archiving sits at the bottom, behind a typed reason. It never deletes: the
 * invoices, payments and attendance stay, because a gym's financial history
 * cannot have holes in it.
 */

/** Field names match the contract and the columns exactly — see members.ts. */
export interface MemberFormValues {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  gender: string;
  occupation: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  notes: string;
}

export function EditMemberForm({
  memberId,
  memberName,
  initial,
  canArchive,
}: {
  memberId: string;
  memberName: string;
  initial: MemberFormValues;
  canArchive: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    const read = (key: string): string => {
      const value = form.get(key);
      return typeof value === 'string' ? value.trim() : '';
    };

    // Only what actually changed, so two people editing different parts of
    // the same member do not overwrite each other.
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(initial) as Array<keyof MemberFormValues>) {
      const next = read(key);
      if (next !== initial[key]) body[key] = next || undefined;
    }

    if (Object.keys(body).length === 0) {
      setSubmitting(false);
      setMessage('Nothing changed.');
      return;
    }

    const response = await fetch(`/api/v1/members/${memberId}`, {
      method: 'PATCH',
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
      setMessage(error?.message ?? 'The changes were not saved.');
      return;
    }

    startTransition(() => {
      router.replace(`/members/${memberId}`);
      router.refresh();
    });
  }

  async function onArchive() {
    if (!archiveReason.trim()) return;
    setSubmitting(true);

    const response = await fetch(`/api/v1/members/${memberId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: archiveReason.trim() }),
    });

    const payload = await response.json().catch(() => null);
    setSubmitting(false);

    if (!response.ok) {
      setMessage(payload?.error?.message ?? 'The member was not archived.');
      return;
    }

    startTransition(() => {
      router.replace('/members');
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
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
            <Field label="First name" name="firstName" defaultValue={initial.firstName} required error={fieldErrors.firstName} />
            <Field label="Last name" name="lastName" defaultValue={initial.lastName} error={fieldErrors.lastName} />
            <Field label="Mobile number" name="phone" defaultValue={initial.phone} required inputMode="numeric" error={fieldErrors.phone} />
            <Field label="Email" name="email" type="email" defaultValue={initial.email} error={fieldErrors.email} />
            <Field label="Date of birth" name="dateOfBirth" type="date" defaultValue={initial.dateOfBirth} error={fieldErrors.dateOfBirth} />
            <div>
              <label htmlFor="field-gender" className="block text-sm font-medium text-ink">
                Gender
              </label>
              <select
                id="field-gender"
                name="gender"
                className="input mt-1"
                defaultValue={initial.gender}
              >
                <option value="">Prefer not to say</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="text-base font-semibold text-ink">Contact and notes</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" name="addressLine1" defaultValue={initial.addressLine1} />
            <Field label="City" name="city" defaultValue={initial.city} />
            <Field label="State" name="state" defaultValue={initial.state} />
            <Field label="PIN code" name="postalCode" defaultValue={initial.postalCode} inputMode="numeric" error={fieldErrors.postalCode} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Emergency contact" name="emergencyContactName" defaultValue={initial.emergencyContactName} />
            <Field label="Their number" name="emergencyContactPhone" defaultValue={initial.emergencyContactPhone} inputMode="numeric" error={fieldErrors.emergencyContactPhone} />
            <Field label="Relationship" name="emergencyContactRelation" defaultValue={initial.emergencyContactRelation} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Occupation" name="occupation" defaultValue={initial.occupation} />
            <Field label="Notes" name="notes" defaultValue={initial.notes} />
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
          <Link href={`/members/${memberId}`} className="btn-ghost">
            Cancel
          </Link>
        </div>
      </form>

      {canArchive && (
        <section className="card p-5">
          <h2 className="text-base font-semibold text-ink">Archive {memberName}</h2>
          <p className="mt-1 text-base text-ink-muted">
            They stop appearing in lists and check-in. Their invoices, payments and attendance are
            kept — nothing is deleted.
          </p>

          {archiving ? (
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="archive-reason" className="block text-sm font-medium text-ink">
                  Why are they being archived?
                </label>
                <input
                  id="archive-reason"
                  className="input mt-1"
                  value={archiveReason}
                  onChange={(event) => setArchiveReason(event.target.value)}
                  placeholder="Moved away, joined another gym…"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="rounded-control bg-rose-600 px-4 py-2 text-base font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                  onClick={onArchive}
                  disabled={submitting || !archiveReason.trim()}
                >
                  Archive member
                </button>
                <button type="button" className="btn-ghost" onClick={() => setArchiving(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-ghost mt-4" onClick={() => setArchiving(true)}>
              Archive…
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  error,
  defaultValue,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  error?: string;
  defaultValue?: string;
  inputMode?: 'numeric' | 'text';
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
        inputMode={inputMode}
        defaultValue={defaultValue}
        className="input mt-1"
        aria-invalid={error ? true : undefined}
      />
      {error && <p className="mt-1 text-sm text-rose-700">{error}</p>}
    </div>
  );
}
