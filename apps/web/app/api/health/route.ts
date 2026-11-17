import { NextResponse } from 'next/server';
import { basePrismaForAuth } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness in one. Uptime monitoring hits this; a deploy is
 * not considered successful until it answers 200 with database: "up".
 */
export async function GET() {
  const startedAt = Date.now();
  let database: 'up' | 'down' = 'down';

  try {
    await basePrismaForAuth().$queryRaw`SELECT 1`;
    database = 'up';
  } catch {
    database = 'down';
  }

  const body = {
    status: database === 'up' ? 'ok' : 'degraded',
    database,
    latencyMs: Date.now() - startedAt,
    version: process.env.APP_VERSION ?? 'dev',
    time: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: database === 'up' ? 200 : 503 });
}
