'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Editing a team member's profile.
 *
 * The pay and bank section only renders for someone who holds
 * `staff.salary.update` — but that is a courtesy, not the control. The
 * server demands the permission the moment any of those fields is present,
 * so hiding the section cannot be worked around by posting the field
 * anyway.
 */

export interface StaffFormValues {
  employeeCode: string;
  designation: string;
  department: string;
  joiningDate: string;
  specialisations: string;
  certifications: string;
  bio: string;
  salaryAmount: string;
  salaryCycle: string;
  bankAccountMasked: string;
  bankIfsc: string;
  panMasked: string;
}

const SALARY_FIELDS = [
  'salaryAmount',
  'salaryCycle',
  'bankAccountMasked',
  'bankIfsc',
  'panMasked',
] as const;

export function StaffProfileForm({
  orgUserId,
  initial,
  canEditSalary,
}: {
  orgUserId: string;
  initial: StaffFormValues;
  canEditSalary: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

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

    // Only what changed, so two people editing different parts of the same
    // profile do not overwrite each other — and so a salary field that was
    // not touched never reaches a server that would demand a permission
    // for it.
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(initial) as Array<keyof StaffFormValues>) {
      if (!canEditSalary && (SALARY_FIELDS as readonly string[]).includes(key)) continue;

      const next = read(key);
      if (next === initial[key]) continue;

      if (key === 'specialisations' || key === 'certifications') {
        body[key] = next
          ? next.split(',').map((part) => part.trim()).filter(Boolean)
          : [];
      } else {
        body[key] = next || null;
      }
    }

    if (Object.keys(body).length === 0) {
      setSubmitting(false);
      setMessage('Nothing changed.');
      return;
    }

    const response = await fetch(`/api/v1/staff/${orgUserId}`, {
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
      setMessage(error?.message ?? 'Those changes were not saved.');
      return;
    }

    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn-ghost" onClick={() => setOpen(true)}>
          Edit profile
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} method="post" className="card space-y-4 p-5" noValidate>
      <h2 className="text-base font-semibold text-ink">Edit profile</h2>

      {message && (
        <p
          role="alert"
          className="rounded-control bg-rose-50 px-3.5 py-2.5 text-base text-rose-800 ring-1 ring-inset ring-rose-200"
        >
          {message}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Designation" name="designation" defaultValue={initial.designation} placeholder="Senior trainer" />
        <Field label="Employee code" name="employeeCode" defaultValue={initial.employeeCode} error={fieldErrors.employeeCode} />
        <Field label="Department" name="department" defaultValue={initial.department} />
        <Field label="Joined on" name="joiningDate" type="date" defaultValue={initial.joiningDate} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Specialises in"
          name="specialisations"
          defaultValue={initial.specialisations}
          hint="Comma separated — strength, rehab, yoga"
        />
        <Field
          label="Certifications"
          name="certifications"
          defaultValue={initial.certifications}
          hint="Comma separated"
        />
      </div>

      <Field label="About" name="bio" defaultValue={initial.bio} hint="Shown to members in the app" />

      {canEditSalary && (
        <fieldset className="rounded-control border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">Pay and bank details</legend>
          <p className="mb-3 text-sm text-ink-muted">
            Only people with the salary permission can see or change this. The amount is kept out
            of the audit log — the fact that it changed is recorded, not the figure.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Amount"
              name="salaryAmount"
              defaultValue={initial.salaryAmount}
              inputMode="decimal"
              error={fieldErrors.salaryAmount}
            />
            <div>
              <label htmlFor="field-salaryCycle" className="block text-sm font-medium text-ink">
                Paid
              </label>
              <select
                id="field-salaryCycle"
                name="salaryCycle"
                className="input mt-1"
                defaultValue={initial.salaryCycle}
              >
                <option value="">Not recorded</option>
                <option value="MONTHLY">Monthly</option>
                <option value="WEEKLY">Weekly</option>
                <option value="DAILY">Daily</option>
                <option value="HOURLY">Hourly</option>
              </select>
            </div>
            <Field
              label="Bank account"
              name="bankAccountMasked"
              defaultValue={initial.bankAccountMasked}
              hint="Last four digits only — never the full number"
              placeholder="XXXX4417"
            />
            <Field
              label="IFSC"
              name="bankIfsc"
              defaultValue={initial.bankIfsc}
              error={fieldErrors.bankIfsc}
              placeholder="HDFC0001234"
            />
          </div>
        </fieldset>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save changes'}
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
  type = 'text',
  defaultValue,
  hint,
  error,
  placeholder,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric' | 'text';
}) {
  const id = `field-${name}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
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
