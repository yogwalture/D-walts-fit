export {
  withTenant,
  withPlatform,
  withActor,
  tenantClient,
  tenantExtension,
  tenantModelNames,
  platformClient,
  platformExtension,
  MissingTenantContextError,
  CrossTenantWriteError,
  NotPlatformStaffError,
  PlatformScopeError,
  type TenantContext,
  type TenantPrismaClient,
  type PlatformPrismaClient,
} from './tenant-client';

export { getJobsClient, Prisma } from './client';

/**
 * The unextended client, for the authentication path ONLY.
 *
 * Session lookup, login and the login-attempt ledger run against tables that
 * sit outside row-level security because they are consulted before any
 * tenant is known (docs/SECURITY.md). Nothing else may use this: every other
 * read has a tenant and belongs in withTenant().
 */
export { basePrisma as authPrisma } from './client';

export type * from '@prisma/client';
