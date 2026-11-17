import { getJobsClient, withTenant } from '@gym/db';
import { AppError } from '../errors';
import { assessPassword, hashPassword } from './password';
import { createSession, type CreatedSession } from './session';
import { consumeToken, issueToken } from './tokens';
import { writeAudit } from '../audit/log';

/**
 * Staff invitations.
 *
 * An administrator never sets another person's password. They issue an
 * invitation; the person sets their own password when they accept it. That
 * single rule removes a whole category of problem — shared credentials,
 * passwords sent over WhatsApp, and a manager who knows the accountant's
 * login.
 */

export interface InviteStaffInput {
  organizationId: string;
  email: string;
  fullName: string;
  roleId: string;
  branchIds?: string[];
  invitedByUserId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface InviteStaffResult {
  token: string;
  expiresAt: Date;
  email: string;
  fullName: string;
  isExistingUser: boolean;
}

export async function inviteStaff(input: InviteStaffInput): Promise<InviteStaffResult> {
  const db = getJobsClient();

  const role = await db.role.findFirst({
    where: {
      id: input.roleId,
      OR: [{ organizationId: null }, { organizationId: input.organizationId }],
      deletedAt: null,
    },
    select: { id: true, key: true, name: true, isPlatform: true },
  });

  if (!role) throw new AppError('NOT_FOUND', 'That role does not exist.');
  if (role.isPlatform) {
    throw new AppError('FORBIDDEN', 'Platform roles cannot be granted inside a gym.');
  }

  // Branches must belong to this gym. Checked here rather than trusted from
  // the request body.
  if (input.branchIds?.length) {
    const valid = await db.branch.count({
      where: { id: { in: input.branchIds }, organizationId: input.organizationId },
    });
    if (valid !== input.branchIds.length) {
      throw new AppError('VALIDATION_FAILED', 'One of those branches is not part of this gym.');
    }
  }

  const existingUser = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, fullName: true },
  });

  if (existingUser) {
    const alreadyHere = await db.orgUser.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: existingUser.id,
        deletedAt: null,
      },
      select: { id: true, status: true },
    });
    if (alreadyHere && alreadyHere.status !== 'INVITED') {
      throw new AppError('CONFLICT', 'That person is already on your staff.');
    }
  }

  const issued = await issueToken(db, {
    type: 'STAFF_INVITATION',
    email: input.email,
    userId: existingUser?.id ?? null,
    organizationId: input.organizationId,
    roleId: role.id,
    branchIds: input.branchIds ?? [],
    createdByUserId: input.invitedByUserId,
    ipAddress: input.ipAddress,
  });

  await withTenant(
    { organizationId: input.organizationId, userId: input.invitedByUserId },
    async (tx) =>
      writeAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.invitedByUserId,
        action: 'staff.invited',
        entityType: 'OrgUser',
        summary: `Invited ${input.email} as ${role.name}`,
        after: { email: input.email, role: role.key, branchIds: input.branchIds ?? [] },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      }),
  );

  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    email: input.email,
    fullName: input.fullName,
    isExistingUser: Boolean(existingUser),
  };
}

export interface AcceptInvitationResult {
  userId: string;
  organizationId: string;
  session: CreatedSession;
}

/**
 * Accepting an invitation creates or links the account and the membership.
 *
 * Runs under the job role: the person has no session and no tenant yet, so
 * there is nothing to scope by — the same reason sessions and verification
 * tokens sit outside row-level security.
 */
export async function acceptInvitation(input: {
  token: string;
  fullName: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<AcceptInvitationResult> {
  const db = getJobsClient();

  const problems = assessPassword(input.password, [input.fullName]);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', problems[0]!, [
      { field: 'password', issue: problems[0]! },
    ]);
  }

  const invitation = await consumeToken(db, 'STAFF_INVITATION', input.token);
  if (!invitation.organizationId || !invitation.roleId) {
    throw new AppError('NOT_FOUND', 'That invitation is invalid or has expired.');
  }

  const organization = await db.organization.findUnique({
    where: { id: invitation.organizationId },
    select: { id: true, status: true, name: true },
  });
  if (!organization || organization.status === 'SUSPENDED') {
    throw new AppError('FORBIDDEN', 'That gym is not accepting staff at the moment.');
  }

  const passwordHash = await hashPassword(input.password);

  const result = await db.$transaction(async (tx: any) => {
    const user = await tx.user.upsert({
      where: { email: invitation.email },
      create: {
        email: invitation.email,
        fullName: input.fullName,
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
      // An existing account keeps its password: an invitation to a second gym
      // must never be a way to reset someone's credentials.
      update: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      select: { id: true },
    });

    const membership = await tx.orgUser.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId!,
          userId: user.id,
        },
      },
      create: {
        organizationId: invitation.organizationId!,
        userId: user.id,
        roleId: invitation.roleId!,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
      update: { status: 'ACTIVE', roleId: invitation.roleId!, acceptedAt: new Date() },
      select: { id: true },
    });

    if (invitation.branchIds.length > 0) {
      await tx.orgUserBranch.createMany({
        data: invitation.branchIds.map((branchId) => ({
          organizationId: invitation.organizationId!,
          orgUserId: membership.id,
          branchId,
        })),
        skipDuplicates: true,
      });
    }

    await tx.consent.createMany({
      data: (['TERMS', 'PRIVACY_POLICY'] as const).map((consentType) => ({
        organizationId: invitation.organizationId!,
        subjectType: 'USER' as const,
        subjectId: user.id,
        consentType,
        granted: true,
        policyVersion: '2026-11-01',
        ipAddress: input.ipAddress,
      })),
    });

    return { userId: user.id, orgUserId: membership.id };
  });

  const session = await createSession(db, {
    userId: result.userId,
    organizationId: invitation.organizationId,
    type: 'WEB',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  await withTenant(
    { organizationId: invitation.organizationId, userId: result.userId },
    async (tx) =>
      writeAudit(tx, {
        organizationId: invitation.organizationId!,
        actorUserId: result.userId,
        action: 'staff.invitation.accepted',
        entityType: 'OrgUser',
        entityId: result.orgUserId,
        summary: `${invitation.email} joined`,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      }),
  );

  return { userId: result.userId, organizationId: invitation.organizationId, session };
}

/** Preview for the acceptance screen: who invited you, and to what. */
export async function describeInvitation(rawToken: string): Promise<{
  email: string;
  organizationName: string;
  roleName: string;
  expiresAt: Date;
} | null> {
  const db = getJobsClient();
  const { hashToken } = await import('./password');

  const record = await db.verificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: {
      type: true,
      email: true,
      organizationId: true,
      roleId: true,
      expiresAt: true,
      consumedAt: true,
    },
  });

  if (
    !record ||
    record.type !== 'STAFF_INVITATION' ||
    record.consumedAt ||
    record.expiresAt.getTime() < Date.now()
  ) {
    return null;
  }

  const [organization, role] = await Promise.all([
    db.organization.findUnique({
      where: { id: record.organizationId! },
      select: { name: true },
    }),
    db.role.findUnique({ where: { id: record.roleId! }, select: { name: true } }),
  ]);

  if (!organization || !role) return null;

  return {
    email: record.email,
    organizationName: organization.name,
    roleName: role.name,
    expiresAt: record.expiresAt,
  };
}
