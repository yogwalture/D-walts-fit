import { Prisma } from '@prisma/client';
import { basePrisma } from './client';

// ---------------------------------------------------------------- types ---

export interface TenantContext {
  /** The acting organization. Comes from the session row — never from a URL,
   *  header or request body. */
  organizationId: string;
  /** The acting user, so the database can answer "which gyms is this person
   *  a member of?" for the organization switcher. */
  userId?: string;
  /** Branch scope. An empty array means organization-wide. */
  branchIds?: string[];
  /** Platform staff acting on platform-owned tables. Never grants access to
   *  a gym's operational data: that still requires organizationId. */
  isPlatform?: boolean;
}

export class MissingTenantContextError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refused ${operation} on tenant model "${model}" with no organization in context. ` +
        'Every tenant query must run inside withTenant().',
    );
    this.name = 'MissingTenantContextError';
  }
}

export class NotPlatformStaffError extends Error {
  constructor(userId: string) {
    super(
      `Refused platform context for user ${userId}: not active platform staff. ` +
        'The platform console is not reachable by a gym\'s own users.',
    );
    this.name = 'NotPlatformStaffError';
  }
}

export class CrossTenantWriteError extends Error {
  constructor(model: string, supplied: string, actual: string) {
    super(
      `Refused write to "${model}" carrying organizationId ${supplied} ` +
        `while the session's organization is ${actual}.`,
    );
    this.name = 'CrossTenantWriteError';
  }
}

// ------------------------------------------------- model classification ---

/**
 * Derived from the generated schema at startup rather than hand-listed, so
 * a table added next year cannot be missed. A model is tenant-scoped if it
 * has an organizationId field; it is "shared library" if that field is
 * optional, meaning NULL rows are platform-provided content every gym reads
 * (the exercise library, default message templates, system roles).
 */
const TENANT_MODELS = new Map<string, { nullableOrg: boolean }>();

for (const model of Prisma.dmmf.datamodel.models) {
  const field = model.fields.find((f) => f.name === 'organizationId');
  if (field) {
    TENANT_MODELS.set(model.name, { nullableOrg: !field.isRequired });
  }
}

/** Looked up before a tenant exists, so it carries no tenant predicate. */
const AUTH_MODELS = new Set(['Session']);

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const SINGLE_WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
]);

const MANY_WHERE_OPERATIONS = new Set(['updateMany', 'deleteMany']);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

// ------------------------------------------------------------ extension ---

function tenantFilter(organizationId: string, nullableOrg: boolean) {
  return nullableOrg
    ? { OR: [{ organizationId }, { organizationId: null }] }
    : { organizationId };
}

function stamp(data: unknown, model: string, organizationId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => stamp(row, model, organizationId));
  }
  if (data && typeof data === 'object') {
    const row = data as Record<string, unknown>;
    const supplied = row.organizationId;
    if (typeof supplied === 'string' && supplied !== organizationId) {
      // A payload trying to plant a row in another gym. Never silently
      // corrected: this is a bug or an attack, and both deserve a stack trace.
      throw new CrossTenantWriteError(model, supplied, organizationId);
    }
    return { ...row, organizationId };
  }
  return data;
}

export function tenantExtension(ctx: TenantContext) {
  return Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const config = TENANT_MODELS.get(model);
          if (!config || AUTH_MODELS.has(model)) return query(args);

          if (!ctx.organizationId) {
            throw new MissingTenantContextError(model, operation);
          }

          const { organizationId } = ctx;
          const filter = tenantFilter(organizationId, config.nullableOrg);

          if (READ_OPERATIONS.has(operation) || MANY_WHERE_OPERATIONS.has(operation)) {
            args.where = args.where ? { AND: [args.where, filter] } : filter;
            return query(args);
          }

          if (SINGLE_WHERE_OPERATIONS.has(operation)) {
            // Prisma's extended whereUnique lets a unique selector carry
            // extra filters, so a primary-key lookup is still tenant-scoped:
            // guessing another gym's UUID returns nothing.
            args.where = { ...(args.where ?? {}) };
            if (!config.nullableOrg) {
              args.where.organizationId = organizationId;
            }
            if (operation === 'update' && args.data) {
              args.data = stamp(args.data, model, organizationId);
            }
            return query(args);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            args.data = stamp(args.data, model, organizationId);
            return query(args);
          }

          if (operation === 'upsert') {
            args.where = { ...(args.where ?? {}) };
            if (!config.nullableOrg) {
              args.where.organizationId = organizationId;
            }
            args.create = stamp(args.create, model, organizationId);
            args.update = stamp(args.update, model, organizationId);
            return query(args);
          }

          return query(args);
        },
      },
    },
  });
}

// ------------------------------------------------------------- runtime ----

export type TenantPrismaClient = ReturnType<typeof tenantClient>;

/**
 * An extended client bound to one tenant. Cheap to build: $extends returns
 * a proxy and opens no connection, so one per request is the intended shape.
 *
 * Prefer withTenant(), which also sets the database-side context. This is
 * exported for the rare read that is already inside a transaction.
 */
export function tenantClient(ctx: TenantContext) {
  return basePrisma.$extends(tenantExtension(ctx));
}

/**
 * Runs `fn` inside one transaction with the tenant context applied to the
 * database session, so row-level security sees it too.
 *
 * set_config(..., true) is transaction-local — the `true` is what makes this
 * correct behind a transaction-mode connection pooler, where one physical
 * connection serves different tenants in sequence.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Omit<TenantPrismaClient, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
  options?: { timeoutMs?: number; maxWaitMs?: number },
): Promise<T> {
  if (!ctx.organizationId) {
    throw new MissingTenantContextError('<transaction>', 'withTenant');
  }

  const client = tenantClient(ctx);

  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.organizationId}::text, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ctx.userId ?? ''}::text, true)`;
      await tx.$executeRaw`SELECT set_config('app.is_platform', ${ctx.isPlatform ? 'on' : 'off'}::text, true)`;
      return fn(tx as never);
    },
    {
      timeout: options?.timeoutMs ?? 15_000,
      maxWait: options?.maxWaitMs ?? 5_000,
    },
  );
}

/**
 * The tables platform context may touch.
 *
 * This list is not a policy of its own: it mirrors, exactly, the tables whose
 * row-level-security policy carries `is_platform_context()`. The database is
 * the boundary; this is a copy kept in step with it so a refused read fails
 * loudly here instead of returning an empty result there. Change it only when
 * the generated RLS changes, and in the same direction.
 */
const PLATFORM_MODELS = new Set([
  'AuditLog',
  'OrgFeatureOverride',
  'OrgUser',
  'SupportTicket',
  'TenantInvoice',
  'TenantPayment',
  'TenantSubscription',
  'UsageCounter',
]);

export class PlatformScopeError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refused ${operation} on "${model}" from platform context: row-level ` +
        'security would answer nothing here, and a silent empty result reads ' +
        'like a gym with no records. Read it inside withTenant({ isPlatform: ' +
        'true }), which writes an audit row the gym owner can see — or, for a ' +
        'cross-tenant count, use getJobsClient() and read counts only.',
    );
    this.name = 'PlatformScopeError';
  }
}

/**
 * Turns the database's silence into an error with a name on it.
 *
 * Platform context can read the commercial tables and nothing else: the
 * operational policies have no `is_platform_context()` escape, so
 * `tx.member.findMany()` there returns `[]` rather than refusing. That empty
 * array is the dangerous part — it is indistinguishable from a gym with no
 * members, and a console built on it would quietly show zeros. So the model
 * is checked before the query runs and the refusal says which call was meant.
 *
 * Its limit, stated plainly because a half-understood guard is worse than
 * none: Prisma extensions see the top-level model only, so a nested
 * `organization.findUnique({ include: { members: true } })` is not caught
 * here. Row-level security still empties it; this just will not explain why.
 */
export function platformExtension() {
  return Prisma.defineExtension({
    name: 'platform-scope',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!TENANT_MODELS.has(model) || PLATFORM_MODELS.has(model)) {
            return query(args);
          }
          throw new PlatformScopeError(model, operation);
        },
      },
    },
  });
}

export type PlatformPrismaClient = ReturnType<typeof platformClient>;

export function platformClient() {
  return basePrisma.$extends(platformExtension());
}

/**
 * Platform-staff context for platform-owned tables (SaaS plans, tenant
 * subscriptions, platform billing, support tickets, the platform audit log).
 *
 * This does NOT open a gym's operational data. Reading a tenant's members or
 * payments still requires entering that tenant explicitly with withTenant,
 * which writes an audit row the gym owner can see.
 */
export async function withPlatform<T>(
  userId: string,
  fn: (tx: Omit<PlatformPrismaClient, '$transaction'>) => Promise<T>,
): Promise<T> {
  // Checked here rather than only at the route, because the route guard is
  // one careless refactor away from being the only thing between a signed-in
  // gym owner and every other gym's commercial figures. Platform context is
  // never opened for somebody who is not platform staff.
  const actor = await basePrisma.user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true, status: true },
  });
  if (!actor?.isPlatformAdmin || actor.status !== 'ACTIVE') {
    throw new NotPlatformStaffError(userId);
  }

  const client = basePrisma.$extends(platformExtension());

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}::text, true)`;
    await tx.$executeRaw`SELECT set_config('app.is_platform', 'on', true)`;
    return fn(tx as never);
  });
}

/**
 * Actor context with NO tenant selected.
 *
 * Exists for exactly one job: resolving a session. At that moment we know who
 * the user is but not yet which gym they are acting in, and we need to read
 * the memberships they may switch into. The `org_users` and `organizations`
 * policies permit that through `current_actor_id()`, so this stays inside
 * row-level security — it simply has no organization to scope to yet.
 *
 * Returns the unextended client, because the tenant extension would refuse a
 * query with no organization. Use it for nothing else: every other read has
 * a tenant and belongs in withTenant().
 */
export async function withActor<T>(
  userId: string,
  fn: (tx: Omit<typeof basePrisma, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
): Promise<T> {
  if (!userId) throw new MissingTenantContextError('<actor>', 'withActor');

  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}::text, true)`;
    await tx.$executeRaw`SELECT set_config('app.is_platform', 'off', true)`;
    return fn(tx as never);
  });
}

/** Models the extension treats as tenant-scoped. Used by the isolation tests. */
export function tenantModelNames(): string[] {
  return [...TENANT_MODELS.keys()].sort();
}
