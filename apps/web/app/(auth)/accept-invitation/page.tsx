import type { Metadata } from 'next';
import Link from 'next/link';
import { describeInvitation } from '@gym/core';
import { AuthShell } from '@/components/auth-shell';
import { AcceptInvitationForm } from './accept-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Accept your invitation' };

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  // Resolved on the server so the page renders the gym and role immediately,
  // rather than flashing an empty form while a fetch decides whether the
  // invitation is even real.
  const invitation = token ? await describeInvitation(token) : null;

  if (!invitation) {
    return (
      <AuthShell
        title="This invitation has expired"
        footer={
          <Link href="/login" className="font-medium text-accent hover:underline">
            Go to sign in
          </Link>
        }
      >
        <p className="text-base text-ink-muted">
          Invitation links work once and last seven days. Ask whoever invited you to send a new
          one.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Join ${invitation.organizationName}`}
      subtitle={`You have been invited as ${invitation.roleName}.`}
      width="md"
    >
      <AcceptInvitationForm
        token={token!}
        email={invitation.email}
        invitedName={invitation.invitedName}
      />
    </AuthShell>
  );
}
