import { authPrisma } from '@gym/db';

/**
 * The auth-path client.
 *
 * Session lookup, login and the login-attempt ledger run against tables that
 * are deliberately outside row-level security, because they are consulted
 * before any tenant is known (see docs/SECURITY.md). This is the only place
 * in the application that reaches for a client without a tenant context.
 *
 * Everything else goes through withTenant() from @gym/db, which carries a
 * context the database can see. ESLint fails the build on any other import
 * of a raw client.
 */
export function basePrismaForAuth() {
  return authPrisma;
}
