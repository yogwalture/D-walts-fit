/**
 * Authentication and the permission engine, end to end against a real
 * database: register a gym, sign in, resolve a session, check what each of
 * the seven roles may actually do, and switch tenants.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  login,
  resolveSession,
  createSession,
  switchOrganization,
  revokeSession,
  revokeAllSessionsForUser,
  resolvePermissions,
  featureLock,
  cheapestPlanWithFeature,
  listSignupPlans,
  requirePermission,
  can,
  scopeOf,
  branchFilter,
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  hashPassword,
  verifyPassword,
  assessPassword,
  redact,
  AppError,
} from '@gym/core';

/** Fixture setup and teardown: the job role, which may cross tenants. */
const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });

/**
 * Everything the application itself does runs on the APPLICATION role, which
 * cannot bypass row-level security. Using the privileged client here would
 * make the suite pass on code that fails in production — which is exactly
 * what happened once: a membership lookup without actor context worked under
 * BYPASSRLS and returned nothing under the app role.
 */
const authDb = authPrisma;

const unique = () => Math.random().toString(36).slice(2, 8);
const STRONG_PASSWORD = 'correct horse battery staple 47';

let registered: Awaited<ReturnType<typeof registerGym>>;
let registeredEmail: string;

beforeAll(async () => {
  registeredEmail = `owner.${unique()}@example.com`;
  registered = await registerGym({
    gymName: `Test Gym ${unique()}`,
    ownerName: 'Test Owner',
    email: registeredEmail,
    phone: '9876501234',
    password: STRONG_PASSWORD,
    city: 'Chhatrapati Sambhajinagar',
    planKey: 'GROWTH',
    acceptedTerms: true,
    ipAddress: '203.0.113.9',
    userAgent: 'vitest',
  });
});

afterAll(async () => {
  // Clean up only what this suite created; the demo tenants stay.
  await db.organization.deleteMany({ where: { id: registered.organizationId } });
  await db.user.deleteMany({ where: { email: registeredEmail } });
  await db.loginAttempt.deleteMany({ where: { email: { contains: '@example.com' } } });
  await db.$disconnect();
});

// =========================================================================

describe('password handling', () => {
  it('hashes with Argon2id and verifies', async () => {
    const digest = await hashPassword(STRONG_PASSWORD);
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(digest, STRONG_PASSWORD)).toBe(true);
    expect(await verifyPassword(digest, STRONG_PASSWORD + 'x')).toBe(false);
  });

  it('two hashes of the same password differ — the salt is per-hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword(STRONG_PASSWORD),
      hashPassword(STRONG_PASSWORD),
    ]);
    expect(a).not.toBe(b);
  });

  it('a malformed stored hash fails closed rather than throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('rejects short passwords and ones containing the user’s own name', () => {
    expect(assessPassword('short')).not.toHaveLength(0);
    expect(assessPassword('yogeshwar-walture-gym', ['Yogeshwar'])).not.toHaveLength(0);
    expect(assessPassword(STRONG_PASSWORD, ['Yogeshwar'])).toHaveLength(0);
  });
});

describe('TOTP', () => {
  it('a generated code verifies, and a wrong one does not', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, generateTotp(secret))).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
  });

  it('accepts one step of clock drift but not five minutes', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const slightlyLate = new Date(now.getTime() - 30_000);
    const veryLate = new Date(now.getTime() - 300_000);

    expect(verifyTotp(secret, generateTotp(secret, slightlyLate), now)).toBe(true);
    expect(verifyTotp(secret, generateTotp(secret, veryLate), now)).toBe(false);
  });
});

// =========================================================================

describe('gym registration', () => {
  it('creates the tenant, owner, branch, trial and its opening records', async () => {
    const org = await db.organization.findUniqueOrThrow({
      where: { id: registered.organizationId },
      include: {
        settings: true,
        branding: true,
        branches: true,
        tenantSubscription: { include: { platformPlan: true } },
        taxRates: true,
        invoiceSequences: true,
        consents: true,
        orgUsers: { include: { role: true, branches: true } },
      },
    });

    expect(org.status).toBe('TRIAL');
    expect(org.settings).not.toBeNull();
    expect(org.branding?.displayName).toBe(org.name);
    expect(org.branches).toHaveLength(1);
    expect(org.branches[0]!.isPrimary).toBe(true);
    expect(org.tenantSubscription?.status).toBe('TRIAL');
    expect(org.tenantSubscription?.platformPlan.key).toBe('GROWTH');
    expect(org.taxRates[0]?.percentage.toString()).toBe('18');
    expect(org.invoiceSequences[0]?.series).toBe('INV');

    // Consent is recorded with its version and origin, not merely implied.
    expect(org.consents.map((c) => c.consentType).sort()).toEqual([
      'PRIVACY_POLICY',
      'TERMS',
    ]);
    expect(org.consents[0]!.policyVersion).toBe('2026-11-01');
    expect(org.consents[0]!.ipAddress).toBe('203.0.113.9');

    expect(org.orgUsers).toHaveLength(1);
    expect(org.orgUsers[0]!.role.key).toBe('GYM_OWNER');
    expect(org.orgUsers[0]!.branches).toHaveLength(1);
  });

  it('writes an audit row for the registration', async () => {
    const audit = await db.auditLog.findFirst({
      where: { organizationId: registered.organizationId, action: 'organization.registered' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(registered.userId);
  });

  it('allocates a unique slug and never a reserved one', async () => {
    const org = await db.organization.findUniqueOrThrow({
      where: { id: registered.organizationId },
    });
    expect(org.slug).toMatch(/^[a-z0-9-]+$/);
    expect(['admin', 'api', 'www', 'platform']).not.toContain(org.slug);
  });

  it('refuses a second registration with the same email address', async () => {
    await expect(
      registerGym({
        gymName: 'Another Gym',
        ownerName: 'Someone Else',
        email: registeredEmail,
        phone: '9876501235',
        password: STRONG_PASSWORD,
        planKey: 'STARTER',
        acceptedTerms: true,
      }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a weak password before creating anything', async () => {
    const email = `weak.${unique()}@example.com`;
    await expect(
      registerGym({
        gymName: 'Weak Password Gym',
        ownerName: 'Test',
        email,
        phone: '9876501236',
        password: 'short',
        planKey: 'STARTER',
        acceptedTerms: true,
      }),
    ).rejects.toThrow(AppError);

    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
});

// =========================================================================

describe('login', () => {
  it('signs in with the right password and returns a session token', async () => {
    const result = await login(authDb, {
      email: registeredEmail,
      password: STRONG_PASSWORD,
      ipAddress: '203.0.113.9',
    });

    expect(result.session.token).toHaveLength(43);
    expect(result.organizationId).toBe(registered.organizationId);

    // Only the hash is stored: the raw token appears nowhere in the database.
    const stored = await db.session.findUniqueOrThrow({
      where: { id: result.session.sessionId },
    });
    expect(stored.tokenHash).not.toBe(result.session.token);
    expect(stored.tokenHash).toHaveLength(64);
  });

  it('gives the same message for a wrong password and an unknown address', async () => {
    const wrongPassword = await login(authDb, {
      email: registeredEmail,
      password: 'definitely-not-the-password',
    }).catch((e: AppError) => e);

    const unknownAccount = await login(authDb, {
      email: `nobody.${unique()}@example.com`,
      password: 'definitely-not-the-password',
    }).catch((e: AppError) => e);

    expect((wrongPassword as AppError).code).toBe('INVALID_CREDENTIALS');
    expect((unknownAccount as AppError).code).toBe('INVALID_CREDENTIALS');
    expect((wrongPassword as AppError).publicMessage).toBe(
      (unknownAccount as AppError).publicMessage,
    );
  });

  it('records every attempt, successful or not', async () => {
    const attempts = await db.loginAttempt.count({ where: { email: registeredEmail } });
    expect(attempts).toBeGreaterThan(0);
  });

  it('locks the account after repeated failures, then reports it as locked', async () => {
    const email = `lockme.${unique()}@example.com`;
    const created = await registerGym({
      gymName: `Lockout Gym ${unique()}`,
      ownerName: 'Lock Test',
      email,
      phone: '9876501237',
      password: STRONG_PASSWORD,
      planKey: 'STARTER',
      acceptedTerms: true,
    });

    for (let i = 0; i < 8; i += 1) {
      await login(authDb, { email, password: 'wrong-password-here' }).catch(() => undefined);
    }

    const locked = await login(authDb, { email, password: STRONG_PASSWORD }).catch(
      (e: AppError) => e,
    );
    expect((locked as AppError).code).toBe('ACCOUNT_LOCKED');

    // The right password does not unlock it early — that is the point.
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.lockedUntil).not.toBeNull();
    expect(user.failedLoginCount).toBeGreaterThanOrEqual(8);

    await db.organization.delete({ where: { id: created.organizationId } });
    await db.user.delete({ where: { email } });
  });
});

// =========================================================================

describe('session resolution', () => {
  it('resolves a token into the actor, the tenant and their permissions', async () => {
    const result = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });
    const { actor, view } = await resolveSession(authDb, result.session.token);

    expect(actor.userId).toBe(registered.userId);
    expect(actor.organizationId).toBe(registered.organizationId);
    expect(view.role?.key).toBe('GYM_OWNER');
    expect(view.user.email).toBe(registeredEmail);
    expect(view.memberships).toHaveLength(1);
    expect(view.organization?.branding.accentColor).toBe('#16A34A');

    // The owner holds the operational permissions and none of the platform ones.
    expect(can(actor.permissions, 'finance.payment.refund')).toBe(true);
    expect(can(actor.permissions, 'members.medical.read')).toBe(true);
    expect(can(actor.permissions, 'org.integration.update')).toBe(true);
    expect(can(actor.permissions, 'platform.gym.suspend')).toBe(false);
  });

  it('rejects an unknown, revoked or expired token', async () => {
    await expect(resolveSession(authDb, 'not-a-real-token')).rejects.toThrow(AppError);

    const result = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });
    await revokeSession(authDb, result.session.sessionId);
    await expect(resolveSession(authDb, result.session.token)).rejects.toThrow(AppError);

    const expired = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });
    await db.session.update({
      where: { id: expired.session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const error = await resolveSession(authDb, expired.session.token).catch((e: AppError) => e);
    expect((error as AppError).code).toBe('SESSION_EXPIRED');
  });

  it('a password reset revokes every existing session', async () => {
    const a = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });
    const b = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });

    const revoked = await revokeAllSessionsForUser(authDb, registered.userId);
    expect(revoked).toBeGreaterThanOrEqual(2);

    await expect(resolveSession(authDb, a.session.token)).rejects.toThrow(AppError);
    await expect(resolveSession(authDb, b.session.token)).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('organization switching', () => {
  it('refuses to switch into a gym the user does not belong to', async () => {
    const other = await db.organization.findUniqueOrThrow({ where: { slug: 'iron-temple' } });
    const result = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });

    const error = await switchOrganization(authDb, {
      sessionId: result.session.sessionId,
      userId: registered.userId,
      organizationId: other.id,
    }).catch((e: AppError) => e);

    expect((error as AppError).code).toBe('FORBIDDEN');

    // And the session's tenant is unchanged.
    const session = await db.session.findUniqueOrThrow({
      where: { id: result.session.sessionId },
    });
    expect(session.organizationId).toBe(registered.organizationId);
  });

  it('allows a switch into a gym the user does belong to', async () => {
    const ironTemple = await db.organization.findUniqueOrThrow({
      where: { slug: 'iron-temple' },
    });
    const managerRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_MANAGER' },
    });

    await db.orgUser.create({
      data: {
        organizationId: ironTemple.id,
        userId: registered.userId,
        roleId: managerRole.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });

    const result = await login(authDb, { email: registeredEmail, password: STRONG_PASSWORD });
    await switchOrganization(authDb, {
      sessionId: result.session.sessionId,
      userId: registered.userId,
      organizationId: ironTemple.id,
    });

    const { actor, view } = await resolveSession(authDb, result.session.token);
    expect(actor.organizationId).toBe(ironTemple.id);
    expect(view.role?.key).toBe('GYM_MANAGER');
    expect(view.memberships).toHaveLength(2);

    // The role changed with the tenant: no refunds as a manager.
    expect(can(actor.permissions, 'finance.payment.refund')).toBe(false);

    await db.orgUser.deleteMany({
      where: { organizationId: ironTemple.id, userId: registered.userId },
    });
  });
});

// =========================================================================

describe('the permission matrix, as seeded', () => {
  async function permissionsFor(roleKey: string, options?: { branchIds?: string[] }) {
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: roleKey },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const plan = await db.platformPlan.findUniqueOrThrow({ where: { key: 'PROFESSIONAL' } });

    return resolvePermissions({
      roleKey,
      rolePermissions: role.permissions,
      overrides: [],
      branchIds: options?.branchIds ?? [],
      planFeatures: plan.features,
      isPlatformAdmin: roleKey === 'SUPER_ADMIN',
    });
  }

  it('the owner can refund; the manager and receptionist cannot', async () => {
    expect(can(await permissionsFor('GYM_OWNER'), 'finance.payment.refund')).toBe(true);
    expect(can(await permissionsFor('GYM_MANAGER'), 'finance.payment.refund')).toBe(false);
    expect(can(await permissionsFor('RECEPTIONIST'), 'finance.payment.refund')).toBe(false);
  });

  it('salary is visible to the owner and accountant only', async () => {
    for (const role of ['GYM_OWNER', 'ACCOUNTANT']) {
      expect(can(await permissionsFor(role), 'staff.salary.read')).toBe(true);
    }
    for (const role of ['GYM_MANAGER', 'RECEPTIONIST', 'TRAINER', 'MEMBER']) {
      expect(can(await permissionsFor(role), 'staff.salary.read')).toBe(false);
    }
  });

  it('integration credentials are the owner’s alone', async () => {
    expect(can(await permissionsFor('GYM_OWNER'), 'org.integration.update')).toBe(true);
    for (const role of ['GYM_MANAGER', 'RECEPTIONIST', 'TRAINER', 'ACCOUNTANT', 'MEMBER']) {
      expect(can(await permissionsFor(role), 'org.integration.update')).toBe(false);
    }
  });

  it('the receptionist can check members in and take payments, but not run payroll', async () => {
    const reception = await permissionsFor('RECEPTIONIST');
    expect(can(reception, 'attendance.checkin.create')).toBe(true);
    expect(can(reception, 'finance.payment.create')).toBe(true);
    expect(can(reception, 'members.member.create')).toBe(true);
    expect(can(reception, 'staff.payroll.manage')).toBe(false);
    expect(can(reception, 'org.audit.read')).toBe(false);
    expect(can(reception, 'comms.campaign.create')).toBe(false);
  });

  it('the trainer works at OWN scope on their members, not ALL', async () => {
    const trainer = await permissionsFor('TRAINER');
    expect(scopeOf(trainer, 'members.member.read')).toBe('OWN');
    expect(scopeOf(trainer, 'fitness.assessment.create')).toBe('OWN');
    expect(can(trainer, 'members.member.create')).toBe(false);
    expect(can(trainer, 'finance.payment.create')).toBe(false);
  });

  it('a member holds only self-service permissions', async () => {
    const member = await permissionsFor('MEMBER');
    expect(can(member, 'self.membership.read')).toBe(true);
    expect(can(member, 'self.attendance.checkin')).toBe(true);
    expect(can(member, 'members.member.read')).toBe(false);
    expect(can(member, 'finance.payment.read')).toBe(false);
    expect(can(member, 'analytics.dashboard.read')).toBe(false);
  });

  it('Super Admin holds platform capabilities and no gym capabilities', async () => {
    const admin = await permissionsFor('SUPER_ADMIN');
    expect(can(admin, 'platform.gym.suspend')).toBe(true);
    expect(can(admin, 'platform.revenue.read')).toBe(true);
    expect(can(admin, 'members.member.read')).toBe(false);
    expect(can(admin, 'finance.payment.refund')).toBe(false);
  });

  it('requirePermission throws rather than returning false', async () => {
    const reception = await permissionsFor('RECEPTIONIST');
    expect(() => requirePermission(reception, 'attendance.checkin.create')).not.toThrow();

    const error = (() => {
      try {
        requirePermission(reception, 'finance.payment.refund');
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(error?.code).toBe('PERMISSION_DENIED');
    expect(error?.status).toBe(403);
  });
});

// =========================================================================

describe('scope narrowing', () => {
  it('assigning a branch narrows ALL to BRANCH on operational permissions', async () => {
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_OWNER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const plan = await db.platformPlan.findUniqueOrThrow({ where: { key: 'PROFESSIONAL' } });

    const orgWide = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: role.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: plan.features,
      isPlatformAdmin: false,
    });

    const branchScoped = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: role.permissions,
      overrides: [],
      branchIds: ['11111111-1111-1111-1111-111111111111'],
      planFeatures: plan.features,
      isPlatformAdmin: false,
    });

    expect(scopeOf(orgWide, 'members.member.read')).toBe('ALL');
    expect(scopeOf(branchScoped, 'members.member.read')).toBe('BRANCH');

    // Organization-level settings stay organization-level.
    expect(scopeOf(branchScoped, 'org.settings.update')).toBe('ALL');

    expect(branchFilter(orgWide, 'members.member.read')).toBeUndefined();
    expect(branchFilter(branchScoped, 'members.member.read')).toEqual({
      in: ['11111111-1111-1111-1111-111111111111'],
    });
  });

  it('an explicit deny override beats the role grant', async () => {
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_OWNER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });

    const resolved = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: role.permissions,
      overrides: [{ permissionKey: 'finance.payment.refund', allow: false, scope: 'ALL' }],
      branchIds: [],
      planFeatures: ['crm', 'classes', 'workouts', 'inventory', 'video', 'whatsapp'],
      isPlatformAdmin: false,
    });

    expect(can(resolved, 'finance.payment.refund')).toBe(false);
    expect(can(resolved, 'finance.payment.create')).toBe(true);
  });

  it('a grant override adds a permission the role does not carry', async () => {
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });

    const resolved = resolvePermissions({
      roleKey: 'RECEPTIONIST',
      rolePermissions: role.permissions,
      overrides: [{ permissionKey: 'finance.payment.refund', allow: true, scope: 'BRANCH' }],
      branchIds: [],
      planFeatures: ['crm', 'classes', 'workouts', 'inventory', 'video', 'whatsapp'],
      isPlatformAdmin: false,
    });

    expect(scopeOf(resolved, 'finance.payment.refund')).toBe('BRANCH');
  });
});

describe('plan feature gating', () => {
  it('a plan without the video feature removes content permissions entirely', async () => {
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_OWNER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });

    const starter = await db.platformPlan.findUniqueOrThrow({ where: { key: 'STARTER' } });
    const professional = await db.platformPlan.findUniqueOrThrow({
      where: { key: 'PROFESSIONAL' },
    });

    const onStarter = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: role.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: starter.features,
      isPlatformAdmin: false,
    });

    const onProfessional = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: role.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: professional.features,
      isPlatformAdmin: false,
    });

    expect(can(onStarter, 'content.video.manage')).toBe(false);
    expect(can(onStarter, 'crm.lead.create')).toBe(false);
    expect(can(onProfessional, 'content.video.manage')).toBe(true);
    expect(can(onProfessional, 'crm.lead.create')).toBe(true);

    // Core gym management is never gated: it is what the product is.
    expect(can(onStarter, 'members.member.create')).toBe(true);
    expect(can(onStarter, 'finance.payment.create')).toBe(true);
    expect(can(onStarter, 'attendance.checkin.create')).toBe(true);
  });

  it('says the plan is what is missing, not the role', async () => {
    const owner = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_OWNER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const trainer = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'TRAINER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const starter = await db.platformPlan.findUniqueOrThrow({ where: { key: 'STARTER' } });

    const ownerOnStarter = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: owner.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: starter.features,
      isPlatformAdmin: false,
    });

    // The owner's role allows it; only the plan is in the way. That is a
    // locked door, and the product should offer the key.
    expect(featureLock(ownerOnStarter, 'crm.lead.read')).toBe('crm');
    expect(() => requirePermission(ownerOnStarter, 'crm.lead.read')).toThrow(
      /plan does not include enquiry and lead management/,
    );
    try {
      requirePermission(ownerOnStarter, 'crm.lead.read');
    } catch (error) {
      expect((error as AppError).code).toBe('FEATURE_NOT_IN_PLAN');
      expect((error as AppError).status).toBe(403);
    }

    const trainerOnStarter = resolvePermissions({
      roleKey: 'TRAINER',
      rolePermissions: trainer.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: starter.features,
      isPlatformAdmin: false,
    });

    // A trainer is not held back by the plan: the role never had it. Telling
    // them to upgrade would be nonsense — the gym already pays for people who
    // cannot see enquiries.
    expect(featureLock(trainerOnStarter, 'finance.payment.refund')).toBeNull();
    try {
      requirePermission(trainerOnStarter, 'finance.payment.refund');
    } catch (error) {
      expect((error as AppError).code).toBe('PERMISSION_DENIED');
    }
  });

  it('does not mark a feature locked once the plan includes it', async () => {
    const owner = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_OWNER' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const growth = await db.platformPlan.findUniqueOrThrow({ where: { key: 'GROWTH' } });

    const resolved = resolvePermissions({
      roleKey: 'GYM_OWNER',
      rolePermissions: owner.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: growth.features,
      isPlatformAdmin: false,
    });

    expect(featureLock(resolved, 'crm.lead.read')).toBeNull();
    expect(resolved.lockedByPlan['crm.lead.read']).toBeUndefined();
    // Growth stops short of the video library, and says so.
    expect(featureLock(resolved, 'content.video.manage')).toBe('video');
  });

  it('names the cheapest plan that would unlock a feature', async () => {
    const crm = await cheapestPlanWithFeature('crm');
    expect(crm?.key).toBe('GROWTH');

    const video = await cheapestPlanWithFeature('video');
    expect(video?.key).toBe('PROFESSIONAL');

    // Not a feature any plan sells: the prompt must not invent a tier.
    expect(await cheapestPlanWithFeature('teleportation')).toBeNull();
  });

  it('offers signup plans without the quoted tier', async () => {
    const plans = await listSignupPlans();
    expect(plans.map((p) => p.key)).toEqual(['STARTER', 'GROWTH', 'PROFESSIONAL']);
    expect(plans[0]!.trialDays).toBeGreaterThan(0);
    // Prices come from the table, so the form cannot drift from the pricing.
    expect(plans[1]!.monthlyPrice).toBeGreaterThan(plans[0]!.monthlyPrice);
  });
});

// =========================================================================

describe('audit redaction', () => {
  it('keeps the shape of a change but never the secrets in it', () => {
    const redacted = redact({
      name: 'Iron Temple',
      passwordHash: '$argon2id$v=19$...',
      whatsapp: { phoneNumberId: '123', accessTokenEncrypted: 'secret-token' },
      staff: [{ fullName: 'A', bankIfsc: 'HDFC0001234' }],
    }) as any;

    expect(redacted.name).toBe('Iron Temple');
    expect(redacted.passwordHash).toBe('[redacted]');
    expect(redacted.whatsapp.phoneNumberId).toBe('123');
    expect(redacted.whatsapp.accessTokenEncrypted).toBe('[redacted]');
    expect(redacted.staff[0].fullName).toBe('A');
    expect(redacted.staff[0].bankIfsc).toBe('[redacted]');
  });
});

// =========================================================================

describe('each seeded role resolves correctly through a real session', () => {
  it('all five staff roles in the demo gym get the right permission set', async () => {
    const org = await db.organization.findUniqueOrThrow({ where: { slug: 'iron-temple' } });

    const expectations: Record<string, { allowed: string[]; denied: string[] }> = {
      GYM_OWNER: {
        allowed: ['finance.payment.refund', 'org.audit.read', 'staff.salary.read'],
        denied: ['platform.gym.suspend'],
      },
      GYM_MANAGER: {
        allowed: ['members.member.create', 'attendance.report.read'],
        denied: ['staff.salary.read', 'finance.payment.refund', 'org.integration.update'],
      },
      RECEPTIONIST: {
        allowed: ['attendance.checkin.create', 'finance.payment.create'],
        denied: ['finance.report.read', 'staff.payroll.read', 'org.audit.read'],
      },
      TRAINER: {
        allowed: ['fitness.workout.manage', 'fitness.assessment.create'],
        denied: ['finance.payment.create', 'members.member.create'],
      },
      ACCOUNTANT: {
        allowed: ['finance.report.read', 'staff.payroll.manage', 'finance.payment.refund'],
        denied: ['attendance.checkin.create', 'members.member.create'],
      },
    };

    for (const [roleKey, expectation] of Object.entries(expectations)) {
      const orgUser = await db.orgUser.findFirstOrThrow({
        where: { organizationId: org.id, role: { key: roleKey } },
        select: { userId: true },
      });

      const session = await createSession(authDb, {
        userId: orgUser.userId,
        organizationId: org.id,
        type: 'WEB',
      });

      const { actor, view } = await resolveSession(authDb, session.token);
      expect(view.role?.key, roleKey).toBe(roleKey);

      for (const permission of expectation.allowed) {
        expect(can(actor.permissions, permission), `${roleKey} should allow ${permission}`).toBe(
          true,
        );
      }
      for (const permission of expectation.denied) {
        expect(can(actor.permissions, permission), `${roleKey} should deny ${permission}`).toBe(
          false,
        );
      }

      await revokeSession(authDb, session.sessionId);
    }
  });
});
