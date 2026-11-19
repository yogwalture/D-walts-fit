import { purgeExpiredTokens } from '../auth/tokens';
import { purgeThrottleHits } from './throttle';

/**
 * The daily tidy-up.
 *
 * Every one of these tables grows with traffic and holds nothing of value
 * after a few days. `purgeExpiredTokens` had been written with a comment
 * saying it was "run by the daily session-and-token job" — and no such job
 * existed, so expired sign-in codes and reset links accumulated for ever.
 * That is not a security hole (they are hashed and expired) but it is a
 * table that only ever gets bigger on a shared host with a disk quota.
 *
 * Bounded on purpose. The deploy target cuts a request off at 120 seconds,
 * so each pass deletes at most a fixed number of rows per table and says
 * whether there is more to do. A scheduler running it hourly catches up on
 * a backlog without any one request timing out — the same shape as the
 * message queue drain.
 */

export interface HousekeepingResult {
  expiredTokens: number;
  deadSessions: number;
  oldLoginAttempts: number;
  oldThrottleHits: number;
  /** True when a table hit its batch limit, so another pass has work to do. */
  moreToDo: boolean;
}

const BATCH = 5_000;

/** Sessions keep 30 days past expiry: long enough to answer "who signed in". */
const SESSION_RETENTION_DAYS = 30;
/** Login attempts keep 30 days: enough to investigate a break-in attempt. */
const LOGIN_ATTEMPT_RETENTION_DAYS = 30;
/** Throttle hits are useless an hour after the longest window. */
const THROTTLE_RETENTION_HOURS = 24;

/**
 * Deletes in one bounded batch, by selecting ids first.
 *
 * `deleteMany` takes no limit, and an unbounded delete on a table with a
 * year of rows is a long transaction holding locks — on a shared database
 * that is everybody's problem, not just ours.
 */
async function deleteBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegate: any,
  where: Record<string, unknown>,
): Promise<{ deleted: number; hitLimit: boolean }> {
  const doomed = await delegate.findMany({
    where,
    select: { id: true },
    take: BATCH,
    orderBy: { id: 'asc' },
  });

  if (doomed.length === 0) return { deleted: 0, hitLimit: false };

  const result = await delegate.deleteMany({
    where: { id: { in: doomed.map((row: { id: string }) => row.id) } },
  });

  return { deleted: result.count, hitLimit: doomed.length === BATCH };
}

export async function runHousekeeping(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<HousekeepingResult> {
  const now = Date.now();

  const expiredTokens = await purgeExpiredTokens(db);

  // An expired session is unusable the moment it expires; these rows are
  // kept a while only so somebody can answer "was this account used?".
  const sessions = await deleteBatch(db.session, {
    OR: [
      { expiresAt: { lt: new Date(now - SESSION_RETENTION_DAYS * 864e5) } },
      { revokedAt: { lt: new Date(now - SESSION_RETENTION_DAYS * 864e5) } },
    ],
  });

  const attempts = await deleteBatch(db.loginAttempt, {
    attemptedAt: { lt: new Date(now - LOGIN_ATTEMPT_RETENTION_DAYS * 864e5) },
  });

  const throttleHits = await purgeThrottleHits(db, THROTTLE_RETENTION_HOURS);

  return {
    expiredTokens,
    deadSessions: sessions.deleted,
    oldLoginAttempts: attempts.deleted,
    oldThrottleHits: throttleHits,
    moreToDo: sessions.hitLimit || attempts.hitLimit,
  };
}

/** What a tidy-up would remove, without removing it. */
export async function housekeepingPending(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<Omit<HousekeepingResult, 'moreToDo'>> {
  const now = Date.now();

  const [expiredTokens, deadSessions, oldLoginAttempts, oldThrottleHits] = await Promise.all([
    db.verificationToken.count({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { consumedAt: { lt: new Date(now - 7 * 864e5) } },
        ],
      },
    }),
    db.session.count({
      where: {
        OR: [
          { expiresAt: { lt: new Date(now - SESSION_RETENTION_DAYS * 864e5) } },
          { revokedAt: { lt: new Date(now - SESSION_RETENTION_DAYS * 864e5) } },
        ],
      },
    }),
    db.loginAttempt.count({
      where: { attemptedAt: { lt: new Date(now - LOGIN_ATTEMPT_RETENTION_DAYS * 864e5) } },
    }),
    db.throttleHit.count({
      where: { occurredAt: { lt: new Date(now - THROTTLE_RETENTION_HOURS * 3_600_000) } },
    }),
  ]);

  return { expiredTokens, deadSessions, oldLoginAttempts, oldThrottleHits };
}
