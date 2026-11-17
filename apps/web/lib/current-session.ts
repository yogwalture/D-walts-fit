import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { SessionView } from '@gym/contracts';
import { resolveSession } from '@gym/core';
import { basePrismaForAuth } from './db';
import { readSessionToken } from './session-cookie';

/**
 * The session, for server components.
 *
 * Wrapped in React's `cache`, so a page and every nested layout that asks for
 * it share one resolution per request rather than hitting the database each
 * time it is read.
 */
export const getSession = cache(async (): Promise<SessionView | null> => {
  const token = await readSessionToken();
  if (!token) return null;

  try {
    const { view } = await resolveSession(basePrismaForAuth(), token);
    return view;
  } catch {
    return null;
  }
});

/** For pages that require a signed-in user inside a gym. */
export async function requireSession(nextPath?: string): Promise<SessionView> {
  const session = await getSession();
  if (!session) {
    const target = nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : '/login';
    redirect(target);
  }
  return session;
}

/**
 * Whether the signed-in user holds a permission.
 *
 * This decides what the interface SHOWS. It is not a security control — the
 * API re-checks every permission regardless, because hiding a button is a
 * courtesy and the server is the boundary.
 */
export function holds(session: SessionView | null, permission: string): boolean {
  if (!session) return false;
  if (session.user.isPlatformAdmin && permission.startsWith('platform.')) return true;
  return permission in session.permissions;
}
