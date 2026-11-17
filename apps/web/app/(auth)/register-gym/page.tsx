import type { Metadata } from 'next';
import Link from 'next/link';
import { RegisterForm } from './register-form';

// A CSP nonce is per request, so it cannot be baked into statically
// prerendered HTML. Pages that ship interactive JavaScript render per
// request so Next can stamp the nonce onto its scripts.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Register your gym' };

export default function RegisterGymPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-md animate-fade-in">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Register your gym</h1>
          <p className="mt-1 text-base text-ink-muted">
            Free for 14 days. No card required.
          </p>
        </div>

        <div className="card p-6">
          <RegisterForm />
        </div>

        <p className="mt-6 text-center text-base text-ink-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
