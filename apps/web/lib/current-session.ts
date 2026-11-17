import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { SessionView } from '@gym/contracts';
import { AppError, resolveSession, type ActorContext } from '@gym/core';
import { basePrismaForAuth } from './db';
import { readSessionToken } from './session-cookie';

/**
 * The session, for server components.
 *
 * Wrapped in React's `cache`, so a page and every nested layout that asks for
 * it share one resolution per request rather than hitting the database each
 * time it is read.
 */
const resolve = cache(
  async (): Promise<{ view: SessionView; actor: ActorContext } | null> => {
    const token = await readSessionToken();
    if (!token) return null;

    try {
      return await resolveSession(basePrismaForAuth(), token);
    } catch {
      return null;
    }
  },
);

export const getSession = cache(async (): Promise<SessionView | null> => {
  const resolved = await resolve();
  return resolved?.view ?? null;
});

/**
 * The same actor the API routes get: the full resolved permission set and
 * the tenant context services take.
 *
 * Server components call services directly rather than fetching their own
 * API over HTTP — one database round trip instead of a loopback request,
 * which on shared hosting also means one entry process instead of two.
 */
export async function requireActor(nextPath?: string): Promise<{
  session: SessionView;
  actor: ActorContext;
  ctx: { organizationId: string; userId: string; branchIds?: string[] };
}> {
  const resolved = await resolve();
  if (!resolved) {
    redirect(nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : '/login');
  }

  const { view, actor } = resolved;
  if (!actor.organizationId) {
    throw new AppError('FORBIDDEN', 'Select a gym before using this.');
  }

  return {
    session: view,
    actor,
    ctx: {
      organizationId: actor.organizationId,
      userId: actor.userId,
      branchIds: actor.permissions.branchIds.length ? actor.permissions.branchIds : undefined,
    },
  };
}

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
