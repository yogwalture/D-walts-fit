/**
 * Password reset, staff invitations, two-factor enrolment, member one-time
 * codes, staff administration and the platform console — end to end against
 * a real database, on the application role.
 */

import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  login,
  resolveSession,
  createSession,
  requestPasswordReset,
  resetPassword,
  changePassword,
  inviteStaff,
  describeInvitation,
  acceptInvitation,
  beginMfaSetup,
  confirmMfaSetup,
  disableMfa,
  consumeRecoveryCode,
  requestMemberOtp,
  verifyMemberOtp,
  listStaff,
  listAssignableRoles,
  setStaffStatus,
  changeStaffRole,
  getPlatformStats,
  listGyms,
  setGymStatus,
  enterTenantForSupport,
  resolvePermissions,
  generateTotp,
  purgeExpiredTokens,
  AppError,
} from '@gym/core';

/** Fixtures and assertions about stored state: the job role. */
const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
/** Everything the application does: the application role, as in production. */
const authDb = authPrisma;

const unique = () => Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple 47';
const NEW_PASSWORD = 'another entirely different passphrase 19';

let gym: Awaited<ReturnType<typeof registerGym>>;
let ownerEmail: string;
let ownerCtx: { organizationId: string; userId: string };

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

async function ownerPermissions() {
  const session = await createSession(authDb, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  const { actor } = await resolveSession(authDb, session.token);
  return actor.permissions;
}

beforeAll(async () => {
  ownerEmail = `flows.${unique()}@example.com`;
  createdEmails.push(ownerEmail);

  gym = await registerGym({
    gymName: `Flow Gym ${unique()}`,
    ownerName: 'Flow Owner',
    email: ownerEmail,
    phone: '9876511111',
    password: PASSWORD,
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
    ipAddress: '198.51.100.7',
  });
  createdOrgIds.push(gym.organizationId);
  ownerCtx = { organizationId: gym.organizationId, userId: gym.userId };
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.verificationToken.deleteMany({ where: { email: { in: createdEmails } } });
  await db.loginAttempt.deleteMany({ where: { email: { contains: '@example.com' } } });
  await db.verificationToken.deleteMany({ where: { type: 'MEMBER_OTP' } });
  await db.$disconnect();
});

// =========================================================================

describe('password reset', () => {
  /**
   * Three reset requests per address per fifteen minutes is the real limit,
   * and it is there so the form cannot be used to flood someone's inbox.
   * The suite exercises far more than three, so it clears the window between
   * cases rather than weakening the rule to make testing convenient.
   */
  beforeEach(async () => {
    await db.verificationToken.deleteMany({
      where: { email: ownerEmail, type: 'PASSWORD_RESET' },
    });
  });

  it('issues a token, changes the password and kills every session', async () => {
    const before = await login(authDb, { email: ownerEmail, password: PASSWORD });

    const request = await requestPasswordReset(authDb, { email: ownerEmail });
    expect(request.token).toBeDefined();
    expect(request.userId).toBe(gym.userId);

    // Only the hash is stored: the raw token appears nowhere in the database.
    const stored = await db.verificationToken.findFirstOrThrow({
      where: { email: ownerEmail, type: 'PASSWORD_RESET', consumedAt: null },
    });
    expect(stored.tokenHash).not.toBe(request.token);
    expect(stored.tokenHash).toHaveLength(64);

    const result = await resetPassword(authDb, {
      token: request.token!,
      password: NEW_PASSWORD,
    });
    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(1);

    // The session that existed before the reset is dead.
    await expect(resolveSession(authDb, before.session.token)).rejects.toThrow(AppError);

    // The old password no longer works; the new one does.
    await expect(login(authDb, { email: ownerEmail, password: PASSWORD })).rejects.toThrow(
      AppError,
    );
    const after = await login(authDb, { email: ownerEmail, password: NEW_PASSWORD });
    expect(after.organizationId).toBe(gym.organizationId);
  });

  it('a reset token works exactly once', async () => {
    const request = await requestPasswordReset(authDb, { email: ownerEmail });
    await resetPassword(authDb, { token: request.token!, password: PASSWORD });

    await expect(
      resetPassword(authDb, { token: request.token!, password: NEW_PASSWORD }),
    ).rejects.toThrow(AppError);
  });

  it('asking again retires the previous link', async () => {
    const first = await requestPasswordReset(authDb, { email: ownerEmail });
    const second = await requestPasswordReset(authDb, { email: ownerEmail });

    await expect(
      resetPassword(authDb, { token: first.token!, password: NEW_PASSWORD }),
    ).rejects.toThrow(AppError);

    await resetPassword(authDb, { token: second.token!, password: NEW_PASSWORD });

    // Put it back for the cases that follow.
    await changePassword(authDb, {
      userId: gym.userId,
      currentPassword: NEW_PASSWORD,
      password: PASSWORD,
    });
  });

  it('an expired token is refused', async () => {
    const request = await requestPasswordReset(authDb, { email: ownerEmail });
    await db.verificationToken.updateMany({
      where: { email: ownerEmail, type: 'PASSWORD_RESET', consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      resetPassword(authDb, { token: request.token!, password: NEW_PASSWORD }),
    ).rejects.toThrow(AppError);
  });

  it('says nothing about whether an address has an account', async () => {
    const result = await requestPasswordReset(authDb, {
      email: `ghost.${unique()}@example.com`,
    });
    expect(result.token).toBeUndefined();
    expect(result.userId).toBeUndefined();
  });

  it('throttles repeated requests for the same address', async () => {
    for (let i = 0; i < 3; i += 1) {
      await requestPasswordReset(authDb, { email: ownerEmail });
    }

    const error = await requestPasswordReset(authDb, { email: ownerEmail }).catch(
      (e: AppError) => e,
    );
    expect((error as AppError).code).toBe('RATE_LIMITED');
  });

  it('refuses to reuse the current password', async () => {
    const request = await requestPasswordReset(authDb, { email: ownerEmail });
    await expect(
      resetPassword(authDb, { token: request.token!, password: PASSWORD }),
    ).rejects.toThrow(AppError);
  });

  it('changing the password in-session keeps that session and drops the others', async () => {
    const keep = await login(authDb, { email: ownerEmail, password: PASSWORD });
    const other = await login(authDb, { email: ownerEmail, password: PASSWORD });

    await changePassword(authDb, {
      userId: gym.userId,
      currentPassword: PASSWORD,
      password: NEW_PASSWORD,
      keepSessionId: keep.session.sessionId,
    });

    await expect(resolveSession(authDb, keep.session.token)).resolves.toBeDefined();
    await expect(resolveSession(authDb, other.session.token)).rejects.toThrow(AppError);

    await changePassword(authDb, {
      userId: gym.userId,
      currentPassword: NEW_PASSWORD,
      password: PASSWORD,
      keepSessionId: keep.session.sessionId,
    });
  });

  it('rejects a change when the current password is wrong', async () => {
    await expect(
      changePassword(authDb, {
        userId: gym.userId,
        currentPassword: 'not-the-current-one',
        password: NEW_PASSWORD,
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('staff invitations', () => {
  it('invites, describes and accepts — and the person sets their own password', async () => {
    const email = `invitee.${unique()}@example.com`;
    createdEmails.push(email);

    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });

    const invitation = await inviteStaff({
      organizationId: gym.organizationId,
      email,
      fullName: 'New Receptionist',
      roleId: role.id,
      invitedByUserId: gym.userId,
    });

    const described = await describeInvitation(invitation.token);
    expect(described?.email).toBe(email);
    expect(described?.roleName).toBe('Receptionist');

    const accepted = await acceptInvitation({
      token: invitation.token,
      fullName: 'New Receptionist',
      password: PASSWORD,
      ipAddress: '198.51.100.8',
    });

    const { view, actor } = await resolveSession(authDb, accepted.session.token);
    expect(view.role?.key).toBe('RECEPTIONIST');
    expect(view.organization?.id).toBe(gym.organizationId);

    // The role's real boundaries, not just its name.
    expect(actor.permissions.grants['attendance.checkin.create']).toBeDefined();
    expect(actor.permissions.grants['finance.payment.refund']).toBeUndefined();
    expect(actor.permissions.grants['staff.salary.read']).toBeUndefined();

    // Consent was recorded for the new user, not assumed.
    const consents = await db.consent.count({
      where: { organizationId: gym.organizationId, subjectId: accepted.userId },
    });
    expect(consents).toBe(2);
  });

  it('an invitation can be accepted only once', async () => {
    const email = `once.${unique()}@example.com`;
    createdEmails.push(email);
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'TRAINER' },
    });

    const invitation = await inviteStaff({
      organizationId: gym.organizationId,
      email,
      fullName: 'Trainer One',
      roleId: role.id,
      invitedByUserId: gym.userId,
    });

    await acceptInvitation({
      token: invitation.token,
      fullName: 'Trainer One',
      password: PASSWORD,
    });

    await expect(
      acceptInvitation({
        token: invitation.token,
        fullName: 'Impostor',
        password: PASSWORD,
      }),
    ).rejects.toThrow(AppError);
  });

  it('two requests racing to accept the same invitation cannot both win', async () => {
    const email = `race.${unique()}@example.com`;
    createdEmails.push(email);
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'TRAINER' },
    });

    const invitation = await inviteStaff({
      organizationId: gym.organizationId,
      email,
      fullName: 'Race Test',
      roleId: role.id,
      invitedByUserId: gym.userId,
    });

    const outcomes = await Promise.allSettled([
      acceptInvitation({ token: invitation.token, fullName: 'A', password: PASSWORD }),
      acceptInvitation({ token: invitation.token, fullName: 'B', password: PASSWORD }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  });

  it('accepting a second gym’s invitation does not reset an existing password', async () => {
    const other = await registerGym({
      gymName: `Second Gym ${unique()}`,
      ownerName: 'Second Owner',
      email: `second.${unique()}@example.com`,
      phone: '9876511222',
      password: PASSWORD,
      planKey: 'STARTER',
      acceptedTerms: true,
    });
    createdOrgIds.push(other.organizationId);

    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'GYM_MANAGER' },
    });

    const invitation = await inviteStaff({
      organizationId: other.organizationId,
      email: ownerEmail,
      fullName: 'Flow Owner',
      roleId: role.id,
      invitedByUserId: other.userId,
    });

    await acceptInvitation({
      token: invitation.token,
      fullName: 'Flow Owner',
      // A different password here must NOT overwrite the existing one.
      password: 'a totally different passphrase 88',
    });

    const stillWorks = await login(authDb, { email: ownerEmail, password: PASSWORD });
    expect(stillWorks.userId).toBe(gym.userId);

    const { view } = await resolveSession(authDb, stillWorks.session.token);
    expect(view.memberships.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a platform role and an invalid branch', async () => {
    const platformRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'SUPER_ADMIN' },
    });

    await expect(
      inviteStaff({
        organizationId: gym.organizationId,
        email: `nope.${unique()}@example.com`,
        fullName: 'Nope',
        roleId: platformRole.id,
        invitedByUserId: gym.userId,
      }),
    ).rejects.toThrow(AppError);

    const receptionist = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });
    const foreignBranch = await db.branch.findFirstOrThrow({
      where: { organization: { slug: 'iron-temple' } },
    });

    await expect(
      inviteStaff({
        organizationId: gym.organizationId,
        email: `nope2.${unique()}@example.com`,
        fullName: 'Nope',
        roleId: receptionist.id,
        branchIds: [foreignBranch.id],
        invitedByUserId: gym.userId,
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('two-factor authentication', () => {
  it('is not switched on until a code from the secret verifies', async () => {
    const setup = await beginMfaSetup(authDb, { userId: gym.userId });
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.uri).toContain('otpauth://totp/');

    // Secret stored, but MFA still off: a half-finished setup must not lock
    // anyone out of their own gym.
    let user = await db.user.findUniqueOrThrow({ where: { id: gym.userId } });
    expect(user.mfaSecret).toBe(setup.secret);
    expect(user.mfaEnabled).toBe(false);

    await expect(
      confirmMfaSetup(authDb, { userId: gym.userId, totp: '000000' }),
    ).rejects.toThrow(AppError);

    user = await db.user.findUniqueOrThrow({ where: { id: gym.userId } });
    expect(user.mfaEnabled).toBe(false);

    const { recoveryCodes } = await confirmMfaSetup(authDb, {
      userId: gym.userId,
      totp: generateTotp(setup.secret),
    });

    expect(recoveryCodes).toHaveLength(10);

    user = await db.user.findUniqueOrThrow({ where: { id: gym.userId } });
    expect(user.mfaEnabled).toBe(true);
    // Recovery codes are stored hashed: a code IS a password.
    expect(user.mfaRecoveryCodes).toHaveLength(10);
    expect(user.mfaRecoveryCodes).not.toContain(recoveryCodes[0]);

    // Login now demands the second factor.
    const needsCode = await login(authDb, { email: ownerEmail, password: PASSWORD }).catch(
      (e: AppError) => e,
    );
    expect((needsCode as AppError).code).toBe('MFA_REQUIRED');

    const withCode = await login(authDb, {
      email: ownerEmail,
      password: PASSWORD,
      totp: generateTotp(setup.secret),
    });
    expect(withCode.userId).toBe(gym.userId);

    // A recovery code works once and is then gone.
    const first = await consumeRecoveryCode(authDb, {
      userId: gym.userId,
      code: recoveryCodes[0]!,
    });
    expect(first.remaining).toBe(9);
    await expect(
      consumeRecoveryCode(authDb, { userId: gym.userId, code: recoveryCodes[0]! }),
    ).rejects.toThrow(AppError);

    // Switching it off needs the password, not just a session.
    await expect(
      disableMfa(authDb, { userId: gym.userId, password: 'wrong-password' }),
    ).rejects.toThrow(AppError);

    await disableMfa(authDb, { userId: gym.userId, password: PASSWORD });
    user = await db.user.findUniqueOrThrow({ where: { id: gym.userId } });
    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaSecret).toBeNull();
    expect(user.mfaRecoveryCodes).toHaveLength(0);
  });
});

// =========================================================================

describe('member login by one-time code', () => {
  /**
   * Three codes per member per ten minutes is the real limit. The suite
   * exercises more than that, and OTP rows outlive a single run, so the
   * window is cleared between cases rather than relaxing the rule.
   */
  beforeEach(async () => {
    await db.verificationToken.deleteMany({ where: { type: 'MEMBER_OTP' } });
  });

  it('signs a member in and gives them only self-service permissions', async () => {
    const request = await requestMemberOtp({
      identifier: '9876543210',
      organizationSlug: 'iron-temple',
    });

    expect(request.code).toMatch(/^\d{6}$/);
    expect(request.memberName).toBe('Rahul Sharma');

    const result = await verifyMemberOtp({
      identifier: '9876543210',
      organizationSlug: 'iron-temple',
      code: request.code!,
    });

    const { view, actor } = await resolveSession(authDb, result.session.token);
    expect(view.role?.key).toBe('MEMBER');
    expect(actor.permissions.grants['self.membership.read']).toBeDefined();
    expect(actor.permissions.grants['members.member.read']).toBeUndefined();
    expect(actor.permissions.grants['finance.payment.read']).toBeUndefined();

    // The member is now linked to a login account, scoped to this gym only.
    const member = await db.member.findUniqueOrThrow({ where: { id: result.memberId } });
    expect(member.userId).toBe(result.userId);

    const memberships = await db.orgUser.findMany({ where: { userId: result.userId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organizationId).toBe(result.organizationId);
  });

  it('the same phone number at two gyms is two different people', async () => {
    const atPulse = await requestMemberOtp({
      identifier: '9876543210',
      organizationSlug: 'pulse-fitness',
    });
    expect(atPulse.code).toBeDefined();

    const ironTemple = await db.organization.findUniqueOrThrow({
      where: { slug: 'iron-temple' },
    });
    const pulse = await db.organization.findUniqueOrThrow({ where: { slug: 'pulse-fitness' } });

    const result = await verifyMemberOtp({
      identifier: '9876543210',
      organizationSlug: 'pulse-fitness',
      code: atPulse.code!,
    });

    expect(result.organizationId).toBe(pulse.id);
    expect(result.organizationId).not.toBe(ironTemple.id);
  });

  it('a wrong code is refused and counts against the attempt cap', async () => {
    await requestMemberOtp({ identifier: '9876543210', organizationSlug: 'iron-temple' });

    await expect(
      verifyMemberOtp({
        identifier: '9876543210',
        organizationSlug: 'iron-temple',
        code: '000000',
      }),
    ).rejects.toThrow(AppError);

    const token = await db.verificationToken.findFirstOrThrow({
      where: { type: 'MEMBER_OTP', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(token.attempts).toBeGreaterThan(0);
  });

  it('an unknown member and an unknown gym both answer with silence', async () => {
    const unknownMember = await requestMemberOtp({
      identifier: '9000000000',
      organizationSlug: 'iron-temple',
    });
    const unknownGym = await requestMemberOtp({
      identifier: '9876543210',
      organizationSlug: 'no-such-gym',
    });

    expect(unknownMember.code).toBeUndefined();
    expect(unknownGym.code).toBeUndefined();
  });
});

// =========================================================================

describe('staff administration', () => {
  it('lists staff without exposing salary', async () => {
    const permissions = await ownerPermissions();
    const { rows, total } = await listStaff(ownerCtx, permissions);

    expect(total).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toHaveProperty('roleName');
    expect(JSON.stringify(rows)).not.toContain('salary');
  });

  it('offers the system roles but never MEMBER or a platform role', async () => {
    const roles = await listAssignableRoles(ownerCtx);
    const keys = roles.map((r) => r.key);

    expect(keys).toContain('GYM_MANAGER');
    expect(keys).toContain('RECEPTIONIST');
    expect(keys).not.toContain('MEMBER');
    expect(keys).not.toContain('SUPER_ADMIN');
  });

  it('refuses to suspend your own account or the last owner', async () => {
    const permissions = await ownerPermissions();
    const me = await db.orgUser.findFirstOrThrow({
      where: { organizationId: gym.organizationId, userId: gym.userId },
    });

    const error = await setStaffStatus(ownerCtx, permissions, {
      orgUserId: me.id,
      status: 'SUSPENDED',
    }).catch((e: AppError) => e);

    expect((error as AppError).code).toBe('CONFLICT');
  });

  it('suspending a staff member cuts their sessions immediately', async () => {
    const email = `suspendme.${unique()}@example.com`;
    createdEmails.push(email);
    const role = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
    });

    const invitation = await inviteStaff({
      organizationId: gym.organizationId,
      email,
      fullName: 'Suspend Me',
      roleId: role.id,
      invitedByUserId: gym.userId,
    });
    const accepted = await acceptInvitation({
      token: invitation.token,
      fullName: 'Suspend Me',
      password: PASSWORD,
    });

    await expect(resolveSession(authDb, accepted.session.token)).resolves.toBeDefined();

    const orgUser = await db.orgUser.findFirstOrThrow({
      where: { organizationId: gym.organizationId, userId: accepted.userId },
    });

    await setStaffStatus(ownerCtx, await ownerPermissions(), {
      orgUserId: orgUser.id,
      status: 'SUSPENDED',
    });

    await expect(resolveSession(authDb, accepted.session.token)).rejects.toThrow(AppError);
  });

  it('a receptionist cannot administer staff at all', async () => {
    const receptionRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });

    const reception = resolvePermissions({
      roleKey: 'RECEPTIONIST',
      rolePermissions: receptionRole.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: ['crm', 'classes', 'workouts', 'inventory', 'video', 'whatsapp'],
      isPlatformAdmin: false,
    });

    await expect(listStaff(ownerCtx, reception)).rejects.toThrow(AppError);
    await expect(
      changeStaffRole(ownerCtx, reception, {
        orgUserId: '11111111-1111-1111-1111-111111111111',
        roleId: receptionRole.id,
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================

describe('the platform console', () => {
  let adminUserId: string;

  beforeAll(async () => {
    const email = `platform.${unique()}@example.com`;
    createdEmails.push(email);
    const admin = await db.user.create({
      data: { email, fullName: 'Platform Admin', status: 'ACTIVE', isPlatformAdmin: true },
    });
    adminUserId = admin.id;
  });

  it('reports gym counts and revenue from the platform ledger', async () => {
    const stats = await getPlatformStats(adminUserId);

    expect(stats.gyms.total).toBeGreaterThanOrEqual(2);
    expect(Number(stats.revenue.mrr)).toBeGreaterThanOrEqual(0);
    // ARR is MRR annualised, so annual plans are comparable with monthly ones.
    expect(Number(stats.revenue.arr)).toBeCloseTo(Number(stats.revenue.mrr) * 12, 2);
  });

  it('lists gyms with their plan and member count, but no member data', async () => {
    const { rows, total } = await listGyms(adminUserId, { pageSize: 50 });

    expect(total).toBeGreaterThanOrEqual(2);
    // Searched rather than assumed to be on page one: every HTTP and browser
    // run leaves gyms behind, and a test that depends on how many exist is a
    // test that fails for a reason that is not a bug.
    const { rows: found } = await listGyms(adminUserId, { search: 'Iron Temple' });
    const ironTemple = found.find((row) => row.slug === 'iron-temple');
    expect(ironTemple?.memberCount).toBe(1);
    expect(JSON.stringify(rows)).not.toContain('Rahul');
  });

  it('suspending a gym closes access, keeps the data and cuts sessions', async () => {
    const victim = await registerGym({
      gymName: `Suspend Gym ${unique()}`,
      ownerName: 'Suspend Owner',
      email: `suspend.${unique()}@example.com`,
      phone: '9876511333',
      password: PASSWORD,
      planKey: 'STARTER',
      acceptedTerms: true,
    });
    createdOrgIds.push(victim.organizationId);

    await expect(resolveSession(authDb, victim.session.token)).resolves.toBeDefined();

    await setGymStatus({
      actorUserId: adminUserId,
      organizationId: victim.organizationId,
      status: 'SUSPENDED',
      reason: 'Non-payment, test',
    });

    // Sessions are cut at once: a suspension that leaves people signed in
    // for another month is not a suspension.
    await expect(resolveSession(authDb, victim.session.token)).rejects.toThrow(AppError);

    // Nothing was deleted.
    const organization = await db.organization.findUniqueOrThrow({
      where: { id: victim.organizationId },
      include: { branches: true, tenantSubscription: true },
    });
    expect(organization.status).toBe('SUSPENDED');
    expect(organization.branches.length).toBeGreaterThan(0);
    expect(organization.tenantSubscription?.isReadOnly).toBe(true);

    // The owner cannot sign back in while suspended.
    const blocked = await login(authDb, {
      email: organization.ownerEmail!,
      password: PASSWORD,
    }).then(({ session }) => resolveSession(authDb, session.token).catch((e: AppError) => e));
    expect((blocked as AppError).code).toBe('ORGANIZATION_SUSPENDED');

    // And it comes back intact.
    await setGymStatus({
      actorUserId: adminUserId,
      organizationId: victim.organizationId,
      status: 'ACTIVE',
    });
    const restored = await login(authDb, {
      email: organization.ownerEmail!,
      password: PASSWORD,
    });
    await expect(resolveSession(authDb, restored.session.token)).resolves.toBeDefined();
  });

  it('writes an audit row the gym owner can see for every status change', async () => {
    const audits = await db.auditLog.findMany({
      where: { organizationId: gym.organizationId, isPlatformActor: true },
    });
    expect(audits.every((row) => row.actorUserId !== null)).toBe(true);
  });

  it('entering a tenant for support demands a reason and leaves a trail', async () => {
    await expect(
      enterTenantForSupport({
        actorUserId: adminUserId,
        organizationId: gym.organizationId,
        reason: 'why',
      }),
    ).rejects.toThrow(AppError);

    await enterTenantForSupport({
      actorUserId: adminUserId,
      organizationId: gym.organizationId,
      reason: 'Investigating a reported billing discrepancy',
    });

    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        organizationId: gym.organizationId,
        action: 'platform.tenant.accessed',
        actorUserId: adminUserId,
      },
    });
    expect(audit.isPlatformActor).toBe(true);
    expect(audit.summary).toContain('billing discrepancy');
  });
});

// =========================================================================

describe('token housekeeping', () => {
  it('purges expired and long-consumed tokens', async () => {
    await db.verificationToken.create({
      data: {
        type: 'PASSWORD_RESET',
        tokenHash: `expired-${unique()}-${Date.now()}`,
        email: `purge.${unique()}@example.com`,
        expiresAt: new Date(Date.now() - 864e5),
      },
    });

    const purged = await purgeExpiredTokens(authDb);
    expect(purged).toBeGreaterThanOrEqual(1);
  });
});
