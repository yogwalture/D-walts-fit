import { NextResponse } from 'next/server';
import { resolveSession } from '@gym/core';
import { route } from '@/lib/handler';
import { basePrismaForAuth } from '@/lib/db';
import { readBearerToken, readSessionToken } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * Who am I, where am I, and what may I do here.
 *
 * The client builds its entire interface from this one response — which
 * items appear in the sidebar, which buttons render, which columns show. The
 * API re-checks every permission regardless, because hiding a button is a
 * courtesy and not a control.
 */
export const GET = route({ public: true }, async ({ request }) => {
  const token = readBearerToken(request) ?? (await readSessionToken());
  if (!token) {
    return NextResponse.json({ data: null }, { status: 200 });
  }

  try {
    const { view } = await resolveSession(basePrismaForAuth(), token);
    return NextResponse.json({ data: view }, { status: 200 });
  } catch {
    // An expired or revoked session is not an error on this route: it is
    // simply "signed out", and the client should render the login screen.
    return NextResponse.json({ data: null }, { status: 200 });
  }
});
