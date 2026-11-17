import { withActor } from '@gym/db';
import { AppError } from '../errors';
import { fakeVerify, verifyPassword } from './password';
import { createSession, type CreatedSession } from './session';

/**
 * Login.
 *
 * Three things are deliberate here:
 *
 *   - the same generic message for an unknown address and a wrong password,
 *     so the response does not enumerate who has an account
 *   - a dummy Argon2 verification on the unknown-address path, so response
 *     TIMING does not enumerate them either
 *   - lockout tracked per email and per IP, so one attacker cannot lock out
 *     every account from one address, and one account cannot be attacked
 *     from many addresses
 */

const MAX_FAILURES = 8;
const LOCKOUT_MINUTES = 15;
const FAILURE_WINDOW_MINUTES = 30;
const IP_FAILURE_LIMIT = 30;

export interface LoginRequest {
  email: string;
  password: string;
  totp?: string;
  ipAddress?: string;
  userAgent?: string;
  type?: 'WEB' | 'MOBILE';
  deviceId?: string;
}

export interface LoginResult {
  session: CreatedSession;
  userId: string;
  organizationId: string | null;
  mfaRequired: false;
}

const invalid = () =>
  new AppError('INVALID_CREDENTIALS', 'That email address or password is not correct.');

export async function login(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: LoginRequest,
): Promise<LoginResult> {
  const windowStart = new Date(Date.now() - FAILURE_WINDOW_MINUTES * 60_000);

  // Per-IP throttle first: cheapest check, and it stops spraying.
  if (input.ipAddress) {
    const ipFailures = await db.loginAttempt.count({
      where: { ipAddress: input.ipAddress, succeeded: false, attemptedAt: { gte: windowStart } },
    });
    if (ipFailures >= IP_FAILURE_LIMIT) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    }
  }

  const user = await db.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      fullName: true,
      passwordHash: true,
      status: true,
      deletedAt: true,
      mfaEnabled: true,
      mfaSecret: true,
      lockedUntil: true,
      failedLoginCount: true,
      isPlatformAdmin: true,
    },
  });

  // Unknown address: burn the same time a real verification takes, record
  // the attempt, and return the same message.
  if (!user || user.deletedAt || !user.passwordHash) {
    await fakeVerify();
    await recordAttempt(db, input, false, 'unknown_account');
    throw invalid();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(
      'ACCOUNT_LOCKED',
      'Too many failed attempts. This account is locked for a few minutes.',
    );
  }

  if (user.status === 'DISABLED') {
    await recordAttempt(db, input, false, 'disabled');
    throw new AppError('ACCOUNT_DISABLED', 'This account has been disabled.');
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failures,
        lockedUntil:
          failures >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });
    await recordAttempt(db, input, false, 'bad_password');
    throw invalid();
  }

  // Password is right. MFA, where enabled, is a second factor and not
  // optional once it is on.
  if (user.mfaEnabled) {
    if (!input.totp) {
      throw new AppError('MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
    }
    const { verifyTotp } = await import('./totp');
    if (!user.mfaSecret || !verifyTotp(user.mfaSecret, input.totp)) {
      await recordAttempt(db, input, false, 'bad_totp');
      throw new AppError('INVALID_CREDENTIALS', 'That code is not correct or has expired.');
    }
  }

  // Pick the organization to land in: the first they belong to, else none
  // (platform admins, and invited users whose membership is still pending).
  //
  // This read goes through withActor, which sets app.current_user_id for the
  // transaction. Without it, row-level security on org_users correctly denies
  // the row and the user lands with no gym — the failure is closed, but it is
  // still a failure.
  const membership = await withActor(user.id, async (tx) =>
    tx.orgUser.findFirst({
      where: { userId: user.id, status: 'ACTIVE', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    }),
  );

  const session = await createSession(db, {
    userId: user.id,
    organizationId: membership?.organizationId ?? null,
    type: input.type ?? 'WEB',
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    deviceId: input.deviceId,
    mfaSatisfied: user.mfaEnabled,
  });

  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await recordAttempt(db, input, true);

  return {
    session,
    userId: user.id,
    organizationId: membership?.organizationId ?? null,
    mfaRequired: false,
  };
}

async function recordAttempt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: LoginRequest,
  succeeded: boolean,
  reason?: string,
): Promise<void> {
  await db.loginAttempt.create({
    data: {
      email: input.email,
      ipAddress: input.ipAddress,
      succeeded,
      reason,
    },
  });
}
