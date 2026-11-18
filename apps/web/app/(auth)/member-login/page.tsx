import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '@/components/auth-shell';
import { MemberLoginForm } from './form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Member sign in' };

export default async function MemberLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ gym?: string }>;
}) {
  const { gym } = await searchParams;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Your phone number and a code — no password to remember."
      footer={
        <Link href="/login" className="font-medium text-accent hover:underline">
          Staff sign in
        </Link>
      }
    >
      <MemberLoginForm gymSlug={gym ?? ''} />
    </AuthShell>
  );
}
