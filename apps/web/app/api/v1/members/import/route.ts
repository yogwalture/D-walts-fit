import { NextResponse } from 'next/server';
import { AppError, listImports, stageImport, type ImportField } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';
import { basePrismaForAuth } from '@/lib/db';
import { resolveSession, requirePermission } from '@gym/core';
import { readBearerToken, readSessionToken } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/** 10 MB, matching the parser's own ceiling. */
const MAX_BYTES = 10 * 1024 * 1024;

export const GET = route({ permission: 'members.member.read' }, async ({ actor }) =>
  listImports(tenantOf(actor), actor.permissions),
);

/**
 * Uploads a spreadsheet and reports what would happen — nothing is created.
 *
 * This route reads the body itself rather than going through the usual JSON
 * wrapper, because the body is a file. The session and permission checks are
 * therefore done by hand here, in the same order the wrapper uses, and the
 * size is capped before the bytes are touched.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = crypto.randomUUID();

  try {
    // --- same gate as every other route, in the same order ---------------
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (origin && host && new URL(origin).host !== host) {
      throw new AppError('FORBIDDEN', 'Request origin is not allowed.');
    }

    const token = readBearerToken(request) ?? (await readSessionToken());
    if (!token) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');

    const { actor } = await resolveSession(basePrismaForAuth(), token);
    requirePermission(actor.permissions, 'members.member.create');

    // --- the file --------------------------------------------------------
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES * 1.5) {
      throw new AppError('VALIDATION_FAILED', 'That file is larger than 10 MB.');
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new AppError('VALIDATION_FAILED', 'Choose a CSV or Excel file to import.');
    }
    if (file.size > MAX_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'That file is larger than 10 MB.');
    }

    // A corrected column map arrives as JSON alongside the file.
    let columnMap: Record<number, ImportField> | undefined;
    const rawMap = form.get('columnMap');
    if (typeof rawMap === 'string' && rawMap.trim()) {
      try {
        const parsed = JSON.parse(rawMap) as Record<string, string>;
        columnMap = Object.fromEntries(
          Object.entries(parsed)
            .filter(([key, value]) => /^\d+$/.test(key) && typeof value === 'string' && value)
            .map(([key, value]) => [Number(key), value as ImportField]),
        );
      } catch {
        throw new AppError('VALIDATION_FAILED', 'The column mapping was not readable.');
      }
    }

    const branchId = form.get('branchId');

    const preview = await stageImport(tenantOf(actor), actor.permissions, {
      bytes: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
      branchId: typeof branchId === 'string' && branchId ? branchId : undefined,
      columnMap,
    });

    return NextResponse.json({ data: preview }, { status: 201 });
  } catch (error) {
    const { toErrorResponse } = await import('@/lib/handler');
    return toErrorResponse(error, requestId);
  }
}
