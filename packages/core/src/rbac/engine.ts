import { permissionDenied, AppError } from '../errors';

/**
 * The permission engine.
 *
 * Permissions are data. The interface hides what a user cannot do; this
 * decides whether they may. Resolution order, applied once per request:
 *
 *   1. the permission set of their role
 *   2. per-person overrides — an explicit DENY always wins
 *   3. intersected with their branch scope
 *   4. intersected with the features their gym's SaaS plan enables
 *   5. Super Admin bypasses 1–4, but never bypasses row-level security
 */

export type Scope = 'ALL' | 'BRANCH' | 'OWN';

export interface ResolvedPermissions {
  /** permission key -> the widest scope the actor holds it at */
  grants: Record<string, Scope>;
  roleKey: string | null;
  branchIds: string[];
  isPlatformAdmin: boolean;
  /** Feature keys the organization's plan unlocks. */
  features: Set<string>;
}

const SCOPE_RANK: Record<Scope, number> = { OWN: 1, BRANCH: 2, ALL: 3 };

/** Which feature key, if any, gates a permission domain. */
const DOMAIN_FEATURE: Record<string, string> = {
  crm: 'crm',
  classes: 'classes',
  fitness: 'workouts',
  inventory: 'inventory',
  content: 'video',
  comms: 'whatsapp',
};

export interface ResolveInput {
  roleKey: string | null;
  rolePermissions: Array<{ permissionKey: string; scope: string }>;
  overrides: Array<{ permissionKey: string; allow: boolean; scope: string }>;
  branchIds: string[];
  planFeatures: string[];
  isPlatformAdmin: boolean;
}

export function resolvePermissions(input: ResolveInput): ResolvedPermissions {
  const features = new Set(input.planFeatures);
  const grants: Record<string, Scope> = {};

  // 1. the role
  for (const { permissionKey, scope } of input.rolePermissions) {
    const next = scope as Scope;
    const current = grants[permissionKey];
    if (!current || SCOPE_RANK[next] > SCOPE_RANK[current]) {
      grants[permissionKey] = next;
    }
  }

  // 2. per-person overrides — deny wins, and wins last
  for (const override of input.overrides) {
    if (override.allow) {
      grants[override.permissionKey] = override.scope as Scope;
    } else {
      delete grants[override.permissionKey];
    }
  }

  // 3. branch scope. A user with no branch rows is organization-wide; one
  //    with branch rows cannot hold ALL on a branch-scoped permission.
  if (input.branchIds.length > 0) {
    for (const [key, scope] of Object.entries(grants)) {
      if (scope === 'ALL' && !key.startsWith('org.') && !key.startsWith('platform.')) {
        grants[key] = 'BRANCH';
      }
    }
  }

  // 4. plan features
  for (const key of Object.keys(grants)) {
    const domain = key.split('.')[0]!;
    const requiredFeature = DOMAIN_FEATURE[domain];
    if (requiredFeature && !features.has(requiredFeature)) {
      delete grants[key];
    }
  }

  return {
    grants,
    roleKey: input.roleKey,
    branchIds: input.branchIds,
    isPlatformAdmin: input.isPlatformAdmin,
    features,
  };
}

// ------------------------------------------------------------- guards ---

export function can(resolved: ResolvedPermissions, permission: string): boolean {
  // 5. Super Admin holds every platform capability. It does NOT grant access
  //    to a gym's operational data: that still needs a tenant context, which
  //    row-level security enforces regardless of what this returns.
  if (resolved.isPlatformAdmin && permission.startsWith('platform.')) return true;
  return permission in resolved.grants;
}

export function scopeOf(resolved: ResolvedPermissions, permission: string): Scope | null {
  if (resolved.isPlatformAdmin && permission.startsWith('platform.')) return 'ALL';
  return resolved.grants[permission] ?? null;
}

/**
 * The single guard at the top of every route handler. Throws rather than
 * returning false, so a forgotten `if` cannot become an authorisation bug.
 */
export function requirePermission(
  resolved: ResolvedPermissions,
  permission: string,
): Scope {
  const scope = scopeOf(resolved, permission);
  if (!scope) throw permissionDenied(permission);
  return scope;
}

/** Requires any one of several permissions — for routes serving two roles. */
export function requireAnyPermission(
  resolved: ResolvedPermissions,
  permissions: string[],
): Scope {
  for (const permission of permissions) {
    const scope = scopeOf(resolved, permission);
    if (scope) return scope;
  }
  throw permissionDenied(permissions.join(' or '));
}

/**
 * Confines a query to the branches the actor may act in. Returns undefined
 * when the actor is organization-wide, so the caller adds no filter.
 */
export function branchFilter(
  resolved: ResolvedPermissions,
  permission: string,
): { in: string[] } | undefined {
  const scope = scopeOf(resolved, permission);
  if (scope !== 'BRANCH') return undefined;
  if (resolved.branchIds.length === 0) {
    // Branch-scoped but assigned to no branch: deny rather than widen.
    throw new AppError(
      'BRANCH_OUT_OF_SCOPE',
      'Your account is not assigned to any branch. Ask an administrator to assign one.',
    );
  }
  return { in: resolved.branchIds };
}

/** Asserts the actor may act in a specific branch. */
export function assertBranchAllowed(resolved: ResolvedPermissions, branchId: string): void {
  if (resolved.branchIds.length === 0) return;
  if (!resolved.branchIds.includes(branchId)) {
    throw new AppError('BRANCH_OUT_OF_SCOPE', 'That branch is outside your access.');
  }
}

export function requireFeature(resolved: ResolvedPermissions, feature: string): void {
  if (!resolved.features.has(feature)) {
    throw new AppError(
      'FEATURE_NOT_IN_PLAN',
      'That feature is not included in your current plan.',
    );
  }
}
