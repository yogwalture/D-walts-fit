import Link from 'next/link';
import { getSession } from '@/lib/current-session';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    title: 'Members and memberships',
    body: 'Register members, sell and renew plans, freeze and transfer, and let expiry handle itself.',
  },
  {
    title: 'QR attendance',
    body: 'Members scan in at reception. Expired memberships are caught at the door, not at the end of the month.',
  },
  {
    title: 'Payments and GST invoices',
    body: 'Cash, UPI, card or online. Proper tax invoices, and a payment is recorded only when the gateway confirms it.',
  },
  {
    title: 'WhatsApp reminders',
    body: 'Expiry, renewal and payment reminders on the official WhatsApp Business API. No unofficial automation.',
  },
  {
    title: 'Member app',
    body: 'Installable on any phone. Membership card, workout plan, class booking and online renewal.',
  },
  {
    title: 'Built for many gyms',
    body: 'Every gym is fully separate — members, money, staff and branding. Enforced by the database, not by convention.',
  },
];

export default async function HomePage() {
  const session = await getSession();
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Management & Fitness Cloud';

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 lg:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-control bg-accent text-sm font-semibold text-white">
              {appName.charAt(0)}
            </span>
            <span className="text-base font-semibold text-ink">{appName}</span>
          </Link>

          <nav className="flex items-center gap-2">
            {session ? (
              <Link href="/dashboard" className="btn-primary">
                Open dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" className="btn-ghost">
                  Sign in
                </Link>
                <Link href="/register-gym" className="btn-primary">
                  Register your gym
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-4 py-20 text-center lg:px-6">
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Run your gym properly.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-ink-muted">
            Members, memberships, attendance, payments and reminders in one place. Built for
            Indian gyms, with GST invoices and WhatsApp that actually work.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/register-gym" className="btn-primary">
              Start free trial
            </Link>
            <Link href="/pricing" className="btn-secondary">
              See pricing
            </Link>
          </div>
          <p className="mt-4 text-sm text-ink-subtle">
            No card required. Your data stays yours, and you can export it at any time.
          </p>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-24 lg:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <article key={feature.title} className="card p-5">
                <h2 className="text-lg font-semibold text-ink">{feature.title}</h2>
                <p className="mt-1.5 text-base text-ink-muted">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-ink-muted lg:px-6">
          <p>
            © {new Date().getFullYear()} {appName}
          </p>
          <nav className="flex gap-4">
            <Link href="/privacy-policy" className="hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/contact" className="hover:text-ink">
              Contact
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
