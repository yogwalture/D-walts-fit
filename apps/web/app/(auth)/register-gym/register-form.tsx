'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface SignupPlan {
  key: string;
  name: string;
  tagline: string | null;
  monthlyPrice: number;
  trialDays: number;
}

/**
 * The plan picked here decides what the gym can use during the trial, so it
 * is part of registration rather than something to discover later from a
 * locked page. Nothing is charged now: every plan starts on its free trial.
 */
export function RegisterForm({ plans }: { plans: SignupPlan[] }) {
  const router = useRouter();
  const [plan, setPlan] = useState(
    plans.find((p) => p.key === 'GROWTH')?.key ?? plans[0]?.key ?? 'STARTER',
  );
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gymName: String(form.get('gymName') ?? ''),
        ownerName: String(form.get('ownerName') ?? ''),
        email: String(form.get('email') ?? ''),
        phone: String(form.get('phone') ?? ''),
        password: String(form.get('password') ?? ''),
        city: String(form.get('city') ?? '') || undefined,
        planKey: plan,
        acceptedTerms: form.get('acceptedTerms') === 'on',
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const error = payload?.error;
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
      router.replace('/dashboard');
      router.refresh();
    });
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
      {message && (
        <div
          role="alert"
          className="rounded-control border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {message}
        </div>
      )}

      <Field name="gymName" label="Gym name" autoFocus error={fieldErrors.gymName} />
      <Field name="ownerName" label="Your name" autoComplete="name" error={fieldErrors.ownerName} />
      <Field name="email" label="Email address" type="email" autoComplete="email" error={fieldErrors.email} />
      <Field name="phone" label="Mobile number" type="tel" autoComplete="tel" inputMode="numeric" error={fieldErrors.phone} />
      <Field name="city" label="City" required={false} error={fieldErrors.city} />

      <fieldset className="space-y-2">
        <legend className="mb-1 block text-sm font-medium text-ink">Plan</legend>
        {plans.map((option) => (
          <label
            key={option.key}
            className={`flex cursor-pointer items-start gap-3 rounded-control border px-3 py-2.5 transition-colors ${
              plan === option.key
                ? 'border-accent bg-accent-soft'
                : 'border-line hover:border-ink-subtle'
            }`}
          >
            <input
              type="radio"
              name="planKey"
              value={option.key}
              checked={plan === option.key}
              onChange={() => setPlan(option.key)}
              className="mt-1"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base font-medium text-ink">{option.name}</span>
                <span className="text-sm text-ink-muted">
                  ₹{option.monthlyPrice.toLocaleString('en-IN')}/month after the trial
                </span>
              </span>
              {option.tagline && (
                <span className="mt-0.5 block text-sm text-ink-muted">{option.tagline}</span>
              )}
            </span>
          </label>
        ))}
        <p className="text-sm text-ink-subtle">
          Free for the first {plans.find((p) => p.key === plan)?.trialDays ?? 7} days, and you
          can change plan afterwards.
        </p>
      </fieldset>

      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="input mt-1.5"
          aria-describedby="password-hint"
          aria-invalid={Boolean(fieldErrors.password)}
        />
        <p id="password-hint" className="mt-1 text-sm text-ink-subtle">
          At least 8 characters.
        </p>
        {fieldErrors.password && <p className="field-error">{fieldErrors.password}</p>}
      </div>

      <label className="flex items-start gap-2.5 text-base text-ink-muted">
        <input
          type="checkbox"
          name="acceptedTerms"
          required
          className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
        />
        <span>
          I accept the terms of service and privacy policy.
        </span>
      </label>
      {fieldErrors.acceptedTerms && <p className="field-error">{fieldErrors.acceptedTerms}</p>}

      <button type="submit" disabled={isPending} className="btn-primary w-full">
        {isPending ? 'Creating your gym…' : 'Create my gym'}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  type = 'text',
  autoComplete,
  inputMode,
  autoFocus,
  required = true,
  error,
}: {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'text';
  autoFocus?: boolean;
  required?: boolean;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="label">
        {label}
        {!required && <span className="font-normal text-ink-subtle"> (optional)</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoFocus={autoFocus}
        required={required}
        className="input mt-1.5"
        aria-invalid={Boolean(error)}
      />
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
