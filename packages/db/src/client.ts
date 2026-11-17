import { PrismaClient, Prisma } from '@prisma/client';

/**
 * The raw Prisma client.
 *
 * This is deliberately NOT exported from the package index. Application
 * code must go through `withTenant` or `withPlatform` in tenant-client.ts,
 * which attach a tenant context the database can also see. An ESLint rule
 * (`no-restricted-imports`) fails the build on any import of this module
 * from outside @gym/db.
 */

const globalForPrisma = globalThis as unknown as {
  __gymPrisma?: PrismaClient;
};

export function createBaseClient(url?: string): PrismaClient {
  return new PrismaClient({
    datasources: url ? { db: { url } } : undefined,
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['warn', 'error'],
  });
}

/**
 * Request-handling client. Connects as the application role, which is
 * neither superuser nor BYPASSRLS, so row-level security applies to every
 * statement it issues — including raw SQL.
 */
export const basePrisma: PrismaClient =
  globalForPrisma.__gymPrisma ?? createBaseClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__gymPrisma = basePrisma;
}

/**
 * Background-job client. Connects as the job role, which holds BYPASSRLS
 * because cron work is legitimately cross-tenant (draining the outbox,
 * expiring subscriptions for every gym). Reachable only from /api/cron
 * handlers — never from a request path.
 */
let jobsClient: PrismaClient | undefined;

export function getJobsClient(): PrismaClient {
  if (!process.env.JOBS_DATABASE_URL) {
    throw new Error(
      'JOBS_DATABASE_URL is not set. Background jobs need the job role; ' +
        'they must not fall back to the request-handling role.',
    );
  }
  jobsClient ??= createBaseClient(process.env.JOBS_DATABASE_URL);
  return jobsClient;
}

export { Prisma, PrismaClient };
