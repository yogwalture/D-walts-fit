'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useState, useTransition } from 'react';

interface FieldErrors {
  [field: string]: string;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [mfaRequired, setMfaRequired] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const body = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      totp: form.get('totp') ? String(form.get('totp')) : undefined,
      rememberDevice: false,
    };

    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const error = payload?.error;

      if (error?.code === 'MFA_REQUIRED') {
        setMfaRequired(true);
        setMessage('Enter the 6-digit code from your authenticator app.');
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
      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : '/dashboard');
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

      <div>
        <label htmlFor="email" className="label">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          className="input mt-1.5"
          aria-invalid={Boolean(fieldErrors.email)}
        />
        {fieldErrors.email && <p className="field-error">{fieldErrors.email}</p>}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="password" className="label">
            Password
          </label>
          <Link href="/forgot-password" className="text-sm text-accent hover:underline">
            Forgot?
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input mt-1.5"
          aria-invalid={Boolean(fieldErrors.password)}
        />
        {fieldErrors.password && <p className="field-error">{fieldErrors.password}</p>}
      </div>

      {mfaRequired && (
        <div className="animate-fade-in">
          <label htmlFor="totp" className="label">
            Authentication code
          </label>
          <input
            id="totp"
            name="totp"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="one-time-code"
            autoFocus
            className="input mt-1.5 text-center font-mono text-lg tracking-[0.4em]"
            placeholder="000000"
          />
        </div>
      )}

      <button type="submit" disabled={isPending} className="btn-primary w-full">
        {isPending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
