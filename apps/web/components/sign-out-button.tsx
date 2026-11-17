'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

export function SignOutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function signOut() {
    // Revokes the session row server-side, not just the cookie: a stolen
    // token is dead the moment the user signs out.
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    startTransition(() => {
      router.replace('/login');
      router.refresh();
    });
  }

  return (
    <button type="button" onClick={signOut} disabled={isPending} className="btn-ghost w-full">
      {isPending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
