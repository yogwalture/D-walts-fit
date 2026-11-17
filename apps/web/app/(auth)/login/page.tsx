import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoginForm } from './login-form';

// A CSP nonce is per request, so it cannot be baked into statically
// prerendered HTML. Pages that ship interactive JavaScript render per
// request so Next can stamp the nonce onto its scripts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud';

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-card bg-accent text-lg font-semibold text-white">
            {appName.charAt(0)}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
          <p className="mt-1 text-base text-ink-muted">Welcome back. Pick up where you left off.</p>
        </div>

        <div className="card p-6">
          {/* useSearchParams reads the ?next= redirect, so the form renders on
              the client. The Suspense boundary lets the page around it stay
              static and arrive first. */}
          <Suspense fallback={<div className="skeleton h-64" />}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-base text-ink-muted">
          New here?{' '}
          <Link href="/register-gym" className="font-medium text-accent hover:underline">
            Register your gym
          </Link>
        </p>
      </div>
    </main>
  );
}
