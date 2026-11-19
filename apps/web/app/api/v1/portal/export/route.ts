import { NextResponse } from 'next/server';
import { memberExportFiles, AppError } from '@gym/core';
import { route } from '@/lib/handler';
import { memberContextOf } from '@/lib/tenant';
import { zipStream, exportFilename } from '@/lib/zip-stream';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * A member's own copy of their own records.
 *
 * India's DPDP Act gives a person the right to a copy of what is held about
 * them, and a gym on this software should be able to honour that without
 * emailing us. The member id comes from the session, so there is no input
 * through which to ask for somebody else's.
 */
export const POST = route({ permission: 'self.export.create' }, async ({ actor }) => {
  const ctx = memberContextOf(actor);
  if (!ctx.memberId) {
    throw new AppError('FORBIDDEN', 'Sign in as a member to export your own data.');
  }

  const { files, memberCode } = await memberExportFiles(ctx, actor.permissions);

  return new NextResponse(zipStream(files), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${exportFilename(memberCode, 'my-data')}"`,
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
    },
  });
});
