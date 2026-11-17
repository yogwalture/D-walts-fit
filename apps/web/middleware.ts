import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware.
 *
 * Deliberately thin. It does NOT resolve the session or check permissions —
 * those need the database, and doing them here would mean either a second
 * round trip per request or trusting a signed cookie's claims, and a claim in
 * a cookie is exactly what we refuse to trust about tenancy.
 *
 * It does three cheap things: a presence check on the session cookie so a
 * signed-out visitor is redirected before any work happens, a
 * Content-Security-Policy with a per-request nonce, and the request id that
 * ties a user-visible error back to a server log line.
 */

const PUBLIC_PATHS = [
  '/',
  '/features',
  '/pricing',
  '/integrations',
  '/about',
  '/contact',
  '/privacy-policy',
  '/terms',
  '/refund-policy',
  '/login',
  '/register-gym',
  '/forgot-password',
  '/reset-password',
  '/accept-invitation',
  '/member-login',
];

const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/webhooks',
  '/api/cron',
  '/api/v1/auth',
  '/api/v1/session',
  '/_next',
  '/favicon',
];

const COOKIE_NAMES = ['__Host-gym_session', 'gym_session'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = crypto.randomUUID().replace(/-/g, '');

  const hasSession = COOKIE_NAMES.some((name) => request.cookies.has(name));

  if (!isPublic(pathname) && !hasSession) {
    // API routes answer with 401 rather than a redirect, so a fetch gets a
    // parseable error instead of a login page body.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } },
        { status: 401 },
      );
    }
    const login = new URL('/login', request.url);
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-request-id', crypto.randomUUID());

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.razorpay.com https://graph.facebook.com",
    "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  // The CSP goes on the REQUEST headers as well as the response. That is not
  // belt and braces: it is how Next.js discovers the nonce and stamps it onto
  // the script tags it renders. Without it the policy blocks Next's own
  // bundles, every page loses its JavaScript, and forms silently degrade to
  // native GET submissions — which is how a password ends up in a URL.
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico)$).*)'],
};
