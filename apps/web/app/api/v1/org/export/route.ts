import { NextResponse } from 'next/server';
import { exportManifest, gymExportFiles } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';
import { zipStream, exportFilename } from '@/lib/zip-stream';

export const dynamic = 'force-dynamic';
// Streamed, so it must not be collected into a static response.
export const runtime = 'nodejs';

/**
 * What is in the export, before anybody waits for it.
 *
 * A gym with four years of history downloads tens of megabytes; telling them
 * the row counts first is the difference between a considered click and a
 * confused one.
 */
export const GET = route({ permission: 'org.export.create' }, async ({ actor }) => {
  const manifest = await exportManifest(tenantOf(actor), actor.permissions);
  return NextResponse.json({ data: manifest });
});

/**
 * The export itself: a ZIP of CSVs, streamed.
 *
 * A POST rather than a GET because it writes an audit row — an export is a
 * bulk read of personal data and the gym is entitled to see that it happened
 * — and because a GET that large invites a browser to prefetch it.
 */
export const POST = route(
  { permission: 'org.export.create' },
  async ({ actor, ipAddress }) => {
    const { manifest, files } = await gymExportFiles(
      tenantOf(actor),
      actor.permissions,
      { ipAddress },
    );

    return new NextResponse(zipStream(files), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${exportFilename(manifest.gym)}"`,
        // Nothing between here and the member's machine should keep a copy
        // of somebody's entire member list.
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
