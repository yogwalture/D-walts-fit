import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-shell';
import { ResetPasswordForm } from './reset-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Set a new password' };

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Set a new password"
      subtitle="Signing in everywhere else will be cancelled."
      footer={
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <Suspense fallback={<div className="skeleton h-48" />}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
