import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline' };

/**
 * What the installed app shows with no connection.
 *
 * It says what is true — the page could not be loaded — rather than showing
 * a stale membership or a class that filled up an hour ago.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold text-ink">No connection</h1>
        <p className="mt-2 text-base text-ink-muted">
          This page needs the internet. Your membership and class places change through the day,
          so we would rather show you nothing than something out of date.
        </p>
        <p className="mt-4 text-sm text-ink-subtle">Try again once you are back on a network.</p>
      </div>
    </main>
  );
}
