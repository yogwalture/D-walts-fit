import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/current-session';
import { SignOutButton } from '@/components/sign-out-button';

/**
 * The member's shell.
 *
 * Built for a phone held one-handed in a changing room: the navigation sits
 * at the bottom where a thumb reaches, and there are four destinations
 * because a member has four questions — when does my membership end, what
 * classes are on, have I been, what do I owe.
 */
const TABS = [
  { href: '/my', label: 'Home' },
  { href: '/my/workout', label: 'Workout' },
  { href: '/my/classes', label: 'Classes' },
  { href: '/my/visits', label: 'Visits' },
  { href: '/my/payments', label: 'Payments' },
] as const;

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) redirect('/member-login');

  // Staff who wander in are sent to the portal they belong in rather than
  // shown an empty member page.
  if (!session.member) redirect('/dashboard');

  const gymName = session.organization?.branding.displayName ?? session.organization?.name ?? '';

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-accent text-sm font-semibold text-white">
            {gymName.charAt(0) || 'G'}
          </div>
          <span className="truncate text-base font-semibold text-ink">{gymName}</span>
        </div>
        <SignOutButton />
      </header>

      <main className="min-w-0 flex-1 p-4 pb-24">{children}</main>

      <nav
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t border-line bg-surface"
        aria-label="Member"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="flex min-h-16 flex-col items-center justify-center gap-0.5 px-2 py-3 text-sm font-medium text-ink-muted transition-colors hover:bg-canvas"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
