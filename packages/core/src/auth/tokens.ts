import { AppError } from '../errors';
import { generateToken, hashToken } from './password';

/**
 * Single-use tokens: password resets, staff invitations, member OTP codes.
 *
 * Four rules hold for every one of them, and they are enforced here rather
 * than remembered at each call site:
 *
 *   - only the SHA-256 is stored, so a database dump yields nothing usable
 *   - consumption is atomic, so a token cannot be redeemed twice in a race
 *   - everything expires
 *   - guessable tokens count their attempts
 */

export type TokenType =
  | 'PASSWORD_RESET'
  | 'STAFF_INVITATION'
  | 'EMAIL_VERIFICATION'
  | 'MEMBER_OTP';

export const TOKEN_LIFETIME_MINUTES: Record<TokenType, number> = {
  PASSWORD_RESET: 30,
  STAFF_INVITATION: 7 * 24 * 60,
  EMAIL_VERIFICATION: 24 * 60,
  MEMBER_OTP: 10,
};

export interface IssueTokenInput {
  type: TokenType;
  email: string;
  userId?: string | null;
  organizationId?: string | null;
  memberId?: string | null;
  roleId?: string | null;
  branchIds?: string[];
  createdByUserId?: string | null;
  ipAddress?: string;
  /** A short numeric code instead of a 32-byte token, for member OTP. */
  code?: string;
  maxAttempts?: number;
  /** For an invitation: the name the inviter typed, so it can be shown back to them. */
  invitedName?: string;
}

export interface IssuedToken {
  id: string;
  /** Returned exactly once. Never readable again. */
  token: string;
  expiresAt: Date;
}

export async function issueToken(
   
  db: any,
  input: IssueTokenInput,
): Promise<IssuedToken> {
  const raw = input.code ?? generateToken().token;
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MINUTES[input.type] * 60_000);

  // A new token of the same kind retires any outstanding one, so a stolen
  // reset link stops working the moment the real owner asks for another.
  await db.verificationToken.updateMany({
    where: { email: input.email, type: input.type, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const record = await db.verificationToken.create({
    data: {
      type: input.type,
      tokenHash: hashToken(raw),
      email: input.email,
      userId: input.userId ?? null,
      organizationId: input.organizationId ?? null,
      memberId: input.memberId ?? null,
      roleId: input.roleId ?? null,
      invitedName: input.invitedName ?? null,
      branchIds: input.branchIds ?? [],
      maxAttempts: input.maxAttempts ?? (input.code ? 5 : 10),
      expiresAt,
      createdByUserId: input.createdByUserId ?? null,
      ipAddress: input.ipAddress,
    },
    select: { id: true },
  });

  return { id: record.id, token: raw, expiresAt };
}

export interface ConsumedToken {
  id: string;
  type: TokenType;
  email: string;
  userId: string | null;
  organizationId: string | null;
  memberId: string | null;
  roleId: string | null;
  branchIds: string[];
}

const invalidToken = () =>
  new AppError('NOT_FOUND', 'That link is invalid or has expired. Please request a new one.');

/**
 * Verifies and consumes in one atomic step.
 *
 * The UPDATE ... WHERE consumedAt IS NULL is the whole point: two requests
 * racing to redeem the same invitation cannot both win, because only one of
 * them changes a row.
 */
export async function consumeToken(
   
  db: any,
  type: TokenType,
  rawToken: string,
  options?: { email?: string },
): Promise<ConsumedToken> {
  const tokenHash = hashToken(rawToken);

  const record = await db.verificationToken.findUnique({ where: { tokenHash } });

  if (!record || record.type !== type) throw invalidToken();
  if (record.consumedAt) throw invalidToken();
  if (record.expiresAt.getTime() < Date.now()) throw invalidToken();
  if (options?.email && record.email !== options.email) {
    await db.verificationToken.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw invalidToken();
  }
  if (record.attempts >= record.maxAttempts) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please request a new code.');
  }

  const claimed = await db.verificationToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  // Lost the race: another request redeemed it microseconds ago.
  if (claimed.count !== 1) throw invalidToken();

  return {
    id: record.id,
    type: record.type,
    email: record.email,
    userId: record.userId,
    organizationId: record.organizationId,
    memberId: record.memberId,
    roleId: record.roleId,
    branchIds: record.branchIds,
  };
}

/** For short codes: records a wrong guess without consuming the token. */
export async function recordFailedAttempt(
   
  db: any,
  email: string,
  type: TokenType,
): Promise<void> {
  await db.verificationToken.updateMany({
    where: { email, type, consumedAt: null },
    data: { attempts: { increment: 1 } },
  });
}

/** Cleanup, run by the daily session-and-token job. */
export async function purgeExpiredTokens(
   
  db: any,
): Promise<number> {
  const result = await db.verificationToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { consumedAt: { lt: new Date(Date.now() - 7 * 864e5) } },
      ],
    },
  });
  return result.count;
}
