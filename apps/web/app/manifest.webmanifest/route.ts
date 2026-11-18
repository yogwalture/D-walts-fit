import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * The install manifest for the member app.
 *
 * Served from a route rather than a static file because the product name
 * and colours are configuration: a white-label gym installs an app with
 * its own name on the home screen, not ours.
 *
 * `start_url` is the member's own page — somebody installing this from
 * their phone is a member, and landing them on a staff login would be a
 * strange welcome.
 */
export async function GET(): Promise<NextResponse> {
  const name = process.env.NEXT_PUBLIC_APP_NAME ?? 'Gym Cloud';

  return NextResponse.json(
    {
      name,
      short_name: name.split(' ')[0] ?? name,
      description: 'Your membership, your classes, your visits.',
      start_url: '/my',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f8fafc',
      theme_color: '#16a34a',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: 'Check in', url: '/my' },
        { name: 'Classes', url: '/my/classes' },
      ],
    },
    {
      headers: {
        'content-type': 'application/manifest+json',
        'cache-control': 'public, max-age=3600',
      },
    },
  );
}
