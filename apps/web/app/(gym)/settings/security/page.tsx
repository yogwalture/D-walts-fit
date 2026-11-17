import type { Metadata } from 'next';
import { requireSession } from '@/lib/current-session';
import { MfaPanel } from './mfa-panel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Security' };

export default async function SecuritySettingsPage() {
  const session = await requireSession('/settings/security');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Security</h1>
        <p className="mt-1 text-base text-ink-muted">
          Settings for your own account, {session.user.fullName}.
        </p>
      </div>

      <MfaPanel enabled={session.user.mfaEnabled} />

      <section className="card p-5">
        <h2 className="text-lg font-semibold text-ink">Sessions</h2>
        <p className="mt-1 text-base text-ink-muted">
          Changing your password signs out every other device. Sessions are stored on the server,
          so signing out takes effect immediately rather than just clearing this browser.
        </p>
      </section>
    </div>
  );
}
