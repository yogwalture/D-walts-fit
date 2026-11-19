import { AppError } from '../errors';
import { assessPassword, hashPassword, verifyPassword } from './password';
import { revokeAllSessionsForUser } from './session';
import { consumeToken, issueToken } from './tokens';
import { throttle, THROTTLES } from '../shared/throttle';

/**
 * Password reset.
 *
 * The request step always reports success, whether or not the address has an
 * account. Anything else turns the "forgot password" form into a way of
 * asking the system who its users are.
 */

export interface ResetRequest {
  email: string;
  ipAddress?: string;
}

export interface ResetRequestResult {
  /** Present only when an account exists. The caller emails it; it is never
   *  returned to the browser. */
  token?: string;
  expiresAt?: Date;
  userId?: string;
  fullName?: string;
}

export async function requestPasswordReset(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: ResetRequest,
): Promise<ResetRequestResult> {
  // Per connection first: the check below limits requests for one email
  // address, which does nothing against a script iterating over addresses
  // to send mail in our name.
  await throttle(db, { ...THROTTLES.passwordReset, key: input.ipAddress });

  // Then by email address, so the form cannot be used to flood one inbox.
  const recent = await db.verificationToken.count({
    where: {
      email: input.email,
      type: 'PASSWORD_RESET',
      createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
    },
  });
  if (recent >= 3) {
    throw new AppError(
      'RATE_LIMITED',
      'A reset link was sent recently. Please check your inbox, or try again shortly.',
    );
  }

  const user = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, fullName: true, status: true, deletedAt: true },
  });

  // No account, or a disabled one: say nothing, do nothing, report success.
  if (!user || user.deletedAt || user.status === 'DISABLED') return {};

  const issued = await issueToken(db, {
    type: 'PASSWORD_RESET',
    email: input.email,
    userId: user.id,
    ipAddress: input.ipAddress,
  });

  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    userId: user.id,
    fullName: user.fullName,
  };
}

export async function resetPassword(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { token: string; password: string },
): Promise<{ userId: string; sessionsRevoked: number }> {
  const consumed = await consumeToken(db, 'PASSWORD_RESET', input.token);
  if (!consumed.userId) {
    throw new AppError('NOT_FOUND', 'That link is invalid or has expired.');
  }

  const user = await db.user.findUnique({
    where: { id: consumed.userId },
    select: { id: true, email: true, fullName: true, passwordHash: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 'That link is invalid or has expired.');

  const problems = assessPassword(input.password, [user.fullName, user.email]);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', problems[0]!, [
      { field: 'password', issue: problems[0]! },
    ]);
  }

  // Reusing the current password is not a reset.
  if (user.passwordHash && (await verifyPassword(user.passwordHash, input.password))) {
    throw new AppError('VALIDATION_FAILED', 'Choose a password you have not used here before.', [
      { field: 'password', issue: 'This is your current password.' },
    ]);
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.password),
      failedLoginCount: 0,
      lockedUntil: null,
      status: 'ACTIVE',
    },
  });

  // Every existing session dies. If the reset was triggered because someone
  // else had the password, this is what actually removes them.
  const sessionsRevoked = await revokeAllSessionsForUser(db, user.id);

  return { userId: user.id, sessionsRevoked };
}

export async function changePassword(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: {
    userId: string;
    currentPassword: string;
    password: string;
    keepSessionId?: string;
  },
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, fullName: true, passwordHash: true },
  });
  if (!user?.passwordHash) throw new AppError('NOT_FOUND', 'Account not found.');

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new AppError('INVALID_CREDENTIALS', 'Your current password is not correct.', [
      { field: 'currentPassword', issue: 'Not correct' },
    ]);
  }

  const problems = assessPassword(input.password, [user.fullName, user.email]);
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', problems[0]!, [
      { field: 'password', issue: problems[0]! },
    ]);
  }

  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.password) },
  });

  // Other devices are signed out; the one doing the changing stays.
  await db.session.updateMany({
    where: {
      userId: user.id,
      revokedAt: null,
      ...(input.keepSessionId ? { id: { not: input.keepSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}
