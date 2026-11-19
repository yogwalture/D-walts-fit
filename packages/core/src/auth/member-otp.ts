import { getJobsClient } from '@gym/db';
import { AppError } from '../errors';
import { generateOtp } from './password';
import { createSession, type CreatedSession } from './session';
import { consumeToken, issueToken, recordFailedAttempt } from './tokens';
import { throttle, THROTTLES } from '../shared/throttle';

/**
 * Member login by one-time code.
 *
 * Members get no password. Most of them join at a reception desk, use the app
 * twice a month, and would either pick something trivial or forget it — so
 * the second factor becomes the only factor and we are better off without the
 * first. A code to their registered phone or email is both simpler for them
 * and harder to share than a password.
 *
 * The member is identified WITHIN a gym: the same phone number may belong to
 * a member of two different gyms, and those are two different people as far
 * as this system is concerned.
 */

export interface OtpRequestResult {
  /** Present only when a member matched. The caller sends it. */
  code?: string;
  expiresAt?: Date;
  memberName?: string;
  channel?: 'sms' | 'whatsapp' | 'email';
  destination?: string;
  /** Who and where, so the caller can send over the gym's own channel. */
  memberId?: string;
  organizationId?: string;
}

function isEmail(identifier: string): boolean {
  return identifier.includes('@');
}

export async function requestMemberOtp(input: {
  identifier: string;
  organizationSlug: string;
  ipAddress?: string;
}): Promise<OtpRequestResult> {
  const db = getJobsClient();

  // Per address, before the per-number cooldown below. That one stops
  // somebody pestering one member; this stops a script walking a list of
  // numbers, where every request that finds a real member costs the gym a
  // WhatsApp message.
  await throttle(db, { ...THROTTLES.memberCodeRequest, key: input.ipAddress });

  const organization = await db.organization.findUnique({
    where: { slug: input.organizationSlug },
    select: { id: true, status: true },
  });

  // An unknown gym and an unknown member look identical from outside: the
  // login form must not confirm which gyms exist either.
  if (!organization || organization.status === 'SUSPENDED') return {};

  const identifier = input.identifier.trim().toLowerCase();

  const member = await db.member.findFirst({
    where: {
      organizationId: organization.id,
      deletedAt: null,
      status: { in: ['ACTIVE', 'INACTIVE'] },
      ...(isEmail(identifier) ? { email: identifier } : { phone: identifier }),
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });

  if (!member) return {};

  const recent = await db.verificationToken.count({
    where: {
      email: identifierKey(member.id),
      type: 'MEMBER_OTP',
      createdAt: { gte: new Date(Date.now() - 10 * 60_000) },
    },
  });
  if (recent >= 3) {
    throw new AppError('RATE_LIMITED', 'A code was sent recently. Please wait a few minutes.');
  }

  const code = generateOtp();
  const issued = await issueToken(db, {
    type: 'MEMBER_OTP',
    // Keyed by member id, not by the identifier: a member who changes their
    // phone number must not inherit codes issued to the old one.
    email: identifierKey(member.id),
    organizationId: organization.id,
    memberId: member.id,
    code,
    maxAttempts: 5,
    ipAddress: input.ipAddress,
  });

  return {
    code: issued.token,
    expiresAt: issued.expiresAt,
    memberName: [member.firstName, member.lastName].filter(Boolean).join(' '),
    channel: isEmail(identifier) ? 'email' : 'whatsapp',
    destination: isEmail(identifier) ? member.email! : member.phone,
    memberId: member.id,
    organizationId: organization.id,
  };
}

export interface MemberLoginResult {
  session: CreatedSession;
  memberId: string;
  organizationId: string;
  userId: string;
}

export async function verifyMemberOtp(input: {
  identifier: string;
  organizationSlug: string;
  code: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<MemberLoginResult> {
  const db = getJobsClient();

  const invalid = () =>
    new AppError('INVALID_CREDENTIALS', 'That code is not correct or has expired.');

  const organization = await db.organization.findUnique({
    where: { slug: input.organizationSlug },
    select: { id: true, status: true },
  });
  if (!organization || organization.status === 'SUSPENDED') throw invalid();

  const identifier = input.identifier.trim().toLowerCase();

  const member = await db.member.findFirst({
    where: {
      organizationId: organization.id,
      deletedAt: null,
      ...(isEmail(identifier) ? { email: identifier } : { phone: identifier }),
    },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, userId: true },
  });
  if (!member) throw invalid();

  let consumed;
  try {
    consumed = await consumeToken(db, 'MEMBER_OTP', input.code, {
      email: identifierKey(member.id),
    });
  } catch (error) {
    await recordFailedAttempt(db, identifierKey(member.id), 'MEMBER_OTP');
    if (error instanceof AppError && error.code === 'RATE_LIMITED') throw error;
    throw invalid();
  }

  if (consumed.memberId !== member.id) throw invalid();

  // Members may have no login account until the first time they sign in.
  // Created here, with the MEMBER role, scoped to this gym only.
  const memberRole = await db.role.findFirst({
    where: { organizationId: null, key: 'MEMBER' },
    select: { id: true },
  });
  if (!memberRole) {
    throw new AppError('INTERNAL_ERROR', 'System roles are not seeded. Run pnpm db:seed.');
  }

  const loginEmail = member.email ?? `${member.phone}@members.${input.organizationSlug}.local`;

  const result = await db.$transaction(async (tx: any) => {
    const user =
      member.userId
        ? await tx.user.findUniqueOrThrow({ where: { id: member.userId }, select: { id: true } })
        : await tx.user.upsert({
            where: { email: loginEmail },
            create: {
              email: loginEmail,
              fullName: [member.firstName, member.lastName].filter(Boolean).join(' '),
              phone: member.phone,
              status: 'ACTIVE',
              phoneVerifiedAt: isEmail(identifier) ? null : new Date(),
              emailVerifiedAt: isEmail(identifier) ? new Date() : null,
            },
            update: { status: 'ACTIVE' },
            select: { id: true },
          });

    if (!member.userId) {
      await tx.member.update({ where: { id: member.id }, data: { userId: user.id } });
    }

    await tx.orgUser.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      create: {
        organizationId: organization.id,
        userId: user.id,
        roleId: memberRole.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
      update: { status: 'ACTIVE' },
    });

    return { userId: user.id };
  });

  const session = await createSession(db, {
    userId: result.userId,
    organizationId: organization.id,
    type: 'WEB',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return {
    session,
    memberId: member.id,
    organizationId: organization.id,
    userId: result.userId,
  };
}

/** Codes are keyed by member id so they survive a change of phone or email. */
function identifierKey(memberId: string): string {
  return `member:${memberId}`;
}
