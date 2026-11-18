'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Adding a branch.
 *
 * The plan limit is the server's to enforce, so a refusal is shown exactly
 * as the server worded it — which names the plan and what it covers, rather
 * than a bare "not allowed".
 */
export function BranchPanel() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [atLimit, setAtLimit] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string): string | undefined => {
      const value = form.get(key);
      const trimmed = typeof value === 'string' ? value.trim() : '';
      return trimmed.length > 0 ? trimmed : undefined;
    };

    setBusy(true);
    setMessage(null);

    const response = await fetch('/api/v1/org/branches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: text('name'),
        code: text('code'),
        city: text('city'),
        addressLine1: text('addressLine1'),
        phone: text('phone'),
      }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);

    if (!response.ok) {
      setAtLimit(payload?.error?.code === 'PLAN_LIMIT_REACHED');
      setMessage(payload?.error?.message ?? 'Something went wrong. Please try again.');
      return;
    }

    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          Add a branch
        </button>
        {atLimit && message && (
          <p className="rounded-control border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-ink">
            {message}
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5" noValidate>
      {message && (
        <div
          role="alert"
          className={`rounded-control px-3 py-2 text-sm ${
            atLimit
              ? 'border border-warning/30 bg-warning/5 text-ink'
              : 'border border-danger/20 bg-danger/5 text-danger'
          }`}
        >
          {message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="name" label="Name" placeholder="Garkheda branch" required autoFocus />
        <Field id="code" label="Code" placeholder="GKD" />
        <Field id="city" label="City" placeholder="Chhatrapati Sambhajinagar" />
        <Field id="phone" label="Phone" placeholder="Optional" />
        <div className="sm:col-span-2">
          <Field id="addressLine1" label="Address" placeholder="Optional" />
        </div>
      </div>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add branch'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  placeholder,
  required,
  autoFocus,
}: {
  id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        name={id}
        className="input"
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
      />
    </div>
  );
}
