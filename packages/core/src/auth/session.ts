import { withActor, withTenant } from '@gym/db';
import type { SessionView } from '@gym/contracts';
import { AppError, unauthenticated } from '../errors';
import { resolvePermissions, type ResolvedPermissions } from '../rbac/engine';
import { generateToken, hashToken } from './password';

const WEB_SESSION_DAYS = 30;
const MOBILE_ACCESS_MINUTES = 15;
const MOBILE_REFRESH_DAYS = 60;

export interface ActorContext {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  permissions: ResolvedPermissions;
  isPlatformAdmin: boolean;
  /**
   * The member record this user is, where they are one.
   *
   * Resolved from the session, never from a parameter: a portal that took
   * the member id from the URL would show anyone who edited it somebody
   * else's invoices.
   */
  memberId?: string | null;
}

// ------------------------------------------------------------- create ---

export interface CreatedSession {
  sessionId: string;
  token: string;
  refreshToken?: string;
  expiresAt: Date;
}

/**
 * Creates a session row and returns the raw token exactly once. Only its
 * hash is stored, so a database dump yields no usable session.
 *
 * Runs on the unextended client: `sessions` is the authentication primitive
 * and deliberately sits outside row-level security — see docs/SECURITY.md.
 */
export async function createSession(
   
  db: any,
  input: {
    userId: string;
    organizationId: string | null;
    type: 'WEB' | 'MOBILE';
    ipAddress?: string;
    userAgent?: string;
    deviceId?: string;
    mfaSatisfied?: boolean;
  },
): Promise<CreatedSession> {
  const access = generateToken();
  const now = Date.now();

  const expiresAt =
    input.type === 'WEB'
      ? new Date(now + WEB_SESSION_DAYS * 864e5)
      : new Date(now + MOBILE_ACCESS_MINUTES * 60_000);

  const refresh = input.type === 'MOBILE' ? generateToken() : undefined;

  const session = await db.session.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      type: input.type,
      tokenHash: access.hash,
      refreshTokenHash: refresh?.hash,
      expiresAt,
      refreshExpiresAt: refresh ? new Date(now + MOBILE_REFRESH_DAYS * 864e5) : undefined,
      mfaSatisfiedAt: input.mfaSatisfied ? new Date() : undefined,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent?.slice(0, 500),
      deviceId: input.deviceId,
    },
    select: { id: true },
  });

  return {
    sessionId: session.id,
    token: access.token,
    refreshToken: refresh?.token,
    expiresAt,
  };
}

// ------------------------------------------------------------ resolve ---

/**
 * Turns a bearer token or session cookie into everything a request needs:
 * who the actor is, which gym they are acting in, and exactly what they may
 * do there.
 *
 * Resolved once per request and cached for it. This is the only place the
 * tenant is decided — never from a URL, header or request body.
 */
export async function resolveSession(
   
  db: any,
  rawToken: string,
): Promise<{ actor: ActorContext; view: SessionView }> {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          status: true,
          mfaEnabled: true,
          isPlatformAdmin: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!session || session.revokedAt) throw unauthenticated();
  if (session.expiresAt.getTime() < Date.now()) {
    throw new AppError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }
  if (!session.user || session.user.deletedAt) throw unauthenticated();
  if (session.user.status === 'DISABLED') {
    throw new AppError('ACCOUNT_DISABLED', 'This account has been disabled.');
  }

  // Memberships, read with the actor context but no tenant selected yet.
  const memberships = await withActor(session.userId, async (tx) =>
    tx.orgUser.findMany({
      where: { userId: session.userId, status: 'ACTIVE', deletedAt: null },
      select: {
        organizationId: true,
        role: { select: { key: true, name: true } },
        organization: { select: { name: true, slug: true, status: true } },
      },
      take: 50,
    }),
  );

  const membershipViews = memberships.map((m: any) => ({
    organizationId: m.organizationId,
    name: m.organization.name,
    slug: m.organization.slug,
    roleKey: m.role.key,
  }));

  // Platform admin with no gym selected: a valid state, with platform
  // permissions and no tenant.
  if (!session.organizationId) {
    const permissions = resolvePermissions({
      roleKey: session.user.isPlatformAdmin ? 'SUPER_ADMIN' : null,
      rolePermissions: [],
      overrides: [],
      branchIds: [],
      planFeatures: [],
      isPlatformAdmin: session.user.isPlatformAdmin,
    });

    return {
      actor: {
        userId: session.userId,
        sessionId: session.id,
        organizationId: null,
        permissions,
        isPlatformAdmin: session.user.isPlatformAdmin,
        memberId: null,
      },
      view: {
        user: {
          id: session.user.id,
          email: session.user.email,
          fullName: session.user.fullName,
          mfaEnabled: session.user.mfaEnabled,
          isPlatformAdmin: session.user.isPlatformAdmin,
        },
        organization: null,
        role: null,
        member: null,
        permissions: permissions.grants,
        planLocked: permissions.lockedByPlan,
        branchIds: [],
        memberships: membershipViews,
      },
    };
  }

  const active = memberships.find((m: any) => m.organizationId === session.organizationId);
  if (!active) {
    // The membership was revoked while the session was alive.
    throw new AppError('FORBIDDEN', 'Your access to this gym has been removed.');
  }
  if (active.organization.status === 'SUSPENDED') {
    throw new AppError('ORGANIZATION_SUSPENDED', 'This gym account is suspended.');
  }

  const resolved = await withTenant(
    { organizationId: session.organizationId, userId: session.userId },
    async (tx) => {
      const [orgUser, organization, member, subscription] = await Promise.all([
        tx.orgUser.findFirst({
          where: { userId: session.userId, organizationId: session.organizationId! },
          select: {
            id: true,
            roleId: true,
            role: {
              select: {
                key: true,
                name: true,
                permissions: { select: { permissionKey: true, scope: true } },
              },
            },
            branches: { select: { branchId: true } },
            permissionOverrides: {
              select: { permissionKey: true, allow: true, scope: true },
            },
          },
        }),
        tx.organization.findFirst({
          where: { id: session.organizationId! },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            branding: {
              select: { displayName: true, primaryColor: true, accentColor: true },
            },
          },
        }),
        // Which member record this user is, where they are one. A member
        // portal that took the member id from a URL would show somebody
        // else's invoices to anyone who edited it.
        tx.member.findFirst({
          where: { userId: session.userId, deletedAt: null },
          select: { id: true, memberCode: true, firstName: true, lastName: true },
        }),
        tx.tenantSubscription.findFirst({
          select: {
            status: true,
            isReadOnly: true,
            platformPlan: { select: { features: true } },
          },
        }),
      ]);

      return { orgUser, organization, member, subscription };
    },
  );

  if (!resolved.orgUser || !resolved.organization) throw unauthenticated();

  const permissions = resolvePermissions({
    roleKey: resolved.orgUser.role.key,
    rolePermissions: resolved.orgUser.role.permissions,
    overrides: resolved.orgUser.permissionOverrides,
    branchIds: resolved.orgUser.branches.map((b: any) => b.branchId),
    planFeatures: resolved.subscription?.platformPlan.features ?? [],
    isPlatformAdmin: session.user.isPlatformAdmin,
    isReadOnly: resolved.subscription?.isReadOnly ?? false,
  });

  return {
    actor: {
      userId: session.userId,
      sessionId: session.id,
      organizationId: session.organizationId,
      permissions,
      isPlatformAdmin: session.user.isPlatformAdmin,
      memberId: resolved.member?.id ?? null,
    },
    view: {
      user: {
        id: session.user.id,
        email: session.user.email,
        fullName: session.user.fullName,
        mfaEnabled: session.user.mfaEnabled,
        isPlatformAdmin: session.user.isPlatformAdmin,
      },
      organization: {
        id: resolved.organization.id,
        name: resolved.organization.name,
        slug: resolved.organization.slug,
        status: resolved.organization.status,
        branding: resolved.organization.branding ?? {
          displayName: null,
          primaryColor: '#0F172A',
          accentColor: '#16A34A',
        },
      },
      role: { key: resolved.orgUser.role.key, name: resolved.orgUser.role.name },
      member: resolved.member
        ? {
            id: resolved.member.id,
            memberCode: resolved.member.memberCode,
            name: `${resolved.member.firstName} ${resolved.member.lastName ?? ''}`.trim(),
          }
        : null,
      permissions: permissions.grants,
      planLocked: permissions.lockedByPlan,
      branchIds: permissions.branchIds,
      memberships: membershipViews,
    },
  };
}

// ------------------------------------------------------------- switch ---

/**
 * Changes the acting organization on the session row.
 *
 * The membership is checked here, server-side, against org_users. There is
 * no client-side path to a different tenant: editing a URL or a cookie value
 * changes nothing, because the tenant is read from this row and nowhere else.
 */
export async function switchOrganization(
   
  db: any,
  input: { sessionId: string; userId: string; organizationId: string },
): Promise<void> {
  const membership = await withActor(input.userId, async (tx) =>
    tx.orgUser.findFirst({
      where: {
        userId: input.userId,
        organizationId: input.organizationId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true, organization: { select: { status: true } } },
    }),
  );

  if (!membership) {
    throw new AppError('FORBIDDEN', 'You do not have access to that gym.');
  }
  if (membership.organization.status === 'SUSPENDED') {
    throw new AppError('ORGANIZATION_SUSPENDED', 'That gym account is suspended.');
  }

  await db.session.update({
    where: { id: input.sessionId },
    data: { organizationId: input.organizationId, lastActiveAt: new Date() },
  });
}

// ------------------------------------------------------------- revoke ---

export async function revokeSession(db: any, sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Used after a password reset: every existing session dies. */
export async function revokeAllSessionsForUser(db: any, userId: string): Promise<number> {
  const result = await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
