import { AppError } from '../errors';
import { hashToken, verifyPassword } from './password';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from './totp';

/**
 * Multi-factor authentication.
 *
 * Enrolment is two steps on purpose. The secret is generated and shown, but
 * nothing is switched on until the person proves they can produce a code from
 * it — otherwise a mistyped setup locks someone out of their own gym.
 *
 * Recovery codes are stored hashed, like passwords, because a recovery code
 * IS a password: it alone defeats the second factor.
 */

export interface MfaSetup {
  secret: string;
  /** otpauth:// URI for the QR code. */
  uri: string;
}

export async function beginMfaSetup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { userId: string; issuer?: string },
): Promise<MfaSetup> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { email: true, mfaEnabled: true },
  });
  if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
  if (user.mfaEnabled) {
    throw new AppError('CONFLICT', 'Two-factor authentication is already switched on.');
  }

  const secret = generateTotpSecret();

  // Stored but not yet active: mfaEnabled stays false until a code verifies.
  await db.user.update({ where: { id: input.userId }, data: { mfaSecret: secret } });

  return {
    secret,
    uri: totpUri(secret, user.email, input.issuer ?? 'Gym Cloud'),
  };
}

export async function confirmMfaSetup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { userId: string; totp: string },
): Promise<{ recoveryCodes: string[] }> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { mfaSecret: true, mfaEnabled: true },
  });

  if (!user?.mfaSecret) {
    throw new AppError('CONFLICT', 'Start the setup again — no pending secret was found.');
  }
  if (user.mfaEnabled) {
    throw new AppError('CONFLICT', 'Two-factor authentication is already switched on.');
  }
  if (!verifyTotp(user.mfaSecret, input.totp)) {
    throw new AppError('INVALID_CREDENTIALS', 'That code is not correct. Try the next one.');
  }

  // Shown once, stored hashed. We cannot show them again, and say so.
  const recoveryCodes = generateRecoveryCodes();

  await db.user.update({
    where: { id: input.userId },
    data: {
      mfaEnabled: true,
      mfaRecoveryCodes: recoveryCodes.map((code) => hashToken(code)),
    },
  });

  return { recoveryCodes };
}

/**
 * Turning MFA off requires the password, not just a session. A borrowed
 * laptop should not be able to remove someone's second factor.
 */
export async function disableMfa(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { userId: string; password: string },
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { passwordHash: true, mfaEnabled: true, isPlatformAdmin: true },
  });

  if (!user?.mfaEnabled) {
    throw new AppError('CONFLICT', 'Two-factor authentication is not switched on.');
  }
  if (user.isPlatformAdmin) {
    throw new AppError(
      'FORBIDDEN',
      'Two-factor authentication is mandatory for platform administrators.',
    );
  }
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) {
    throw new AppError('INVALID_CREDENTIALS', 'That password is not correct.');
  }

  await db.user.update({
    where: { id: input.userId },
    data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [] },
  });
}

/**
 * Redeems a recovery code. Single use: the code is removed as it is spent,
 * so a screenshot of the list loses one line each time it is used.
 */
export async function consumeRecoveryCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: { userId: string; code: string },
): Promise<{ remaining: number }> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { mfaRecoveryCodes: true, mfaEnabled: true },
  });

  if (!user?.mfaEnabled) {
    throw new AppError('CONFLICT', 'Two-factor authentication is not switched on.');
  }

  const supplied = hashToken(input.code.trim().toUpperCase());
  const remaining = user.mfaRecoveryCodes.filter((stored: string) => stored !== supplied);

  if (remaining.length === user.mfaRecoveryCodes.length) {
    throw new AppError('INVALID_CREDENTIALS', 'That recovery code is not valid.');
  }

  await db.user.update({
    where: { id: input.userId },
    data: { mfaRecoveryCodes: remaining },
  });

  return { remaining: remaining.length };
}
