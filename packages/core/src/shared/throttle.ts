import { AppError } from '../errors';

/**
 * Throttling public endpoints.
 *
 * Counted in the database rather than in memory, because the deploy target
 * runs the app as more than one process behind a pool: an in-memory counter
 * would give each worker its own allowance and a round-robin attacker the
 * sum of them. One row per hit is a write per request on the few endpoints
 * that need it, which is the right trade at this traffic.
 *
 * What this is NOT: protection against a volumetric attack. A flood from a
 * thousand addresses is stopped at the edge — Cloudflare, or whatever sits
 * in front — and pretending an application-level counter handles it would
 * be worse than saying so. This stops the single script hammering one
 * endpoint, which is the realistic abuse of a self-serve signup form.
 */

export interface ThrottleRule {
  /** What is being limited, e.g. 'registration'. */
  bucket: string;
  /** Who it is counted against — an IP address, usually. */
  key: string | undefined;
  limit: number;
  windowMinutes: number;
  /** Shown to whoever hit the limit. Never says what the limit is. */
  message: string;
}

/**
 * Records a hit and refuses if the window is full.
 *
 * The hit is recorded BEFORE the check, so a request that is refused still
 * counts: otherwise somebody sitting exactly on the limit gets a fresh
 * allowance every time they are turned away, and the limit never bites.
 */
export async function throttle(
   
  db: any,
  rule: ThrottleRule,
): Promise<void> {
  // No key means we cannot attribute the request — behind a proxy that
  // strips the forwarded address, say. Letting it through is deliberate:
  // the alternative is one misconfigured header blocking every signup.
  if (!rule.key) return;

  const since = new Date(Date.now() - rule.windowMinutes * 60_000);

  await db.throttleHit.create({ data: { bucket: rule.bucket, key: rule.key } });

  const hits = await db.throttleHit.count({
    where: { bucket: rule.bucket, key: rule.key, occurredAt: { gte: since } },
  });

  if (hits > rule.limit) {
    throw new AppError('RATE_LIMITED', rule.message);
  }
}

/**
 * How many are left, without counting a hit. For a screen that wants to warn
 * somebody before it refuses them.
 */
export async function throttleRemaining(
   
  db: any,
  rule: Omit<ThrottleRule, 'message'>,
): Promise<number> {
  if (!rule.key) return rule.limit;

  const since = new Date(Date.now() - rule.windowMinutes * 60_000);
  const hits = await db.throttleHit.count({
    where: { bucket: rule.bucket, key: rule.key, occurredAt: { gte: since } },
  });

  return Math.max(0, rule.limit - hits);
}

/**
 * Clears hits older than the longest window anybody uses.
 *
 * Called by the housekeeping cron. Without it the table grows forever, which
 * on a shared host is a disk filling up for no reason — the rows are useless
 * minutes after they are written.
 */
export async function purgeThrottleHits(
   
  db: any,
  olderThanHours = 24,
): Promise<number> {
  const result = await db.throttleHit.deleteMany({
    where: { occurredAt: { lt: new Date(Date.now() - olderThanHours * 3_600_000) } },
  });
  return result.count;
}

/** The rules, in one place, so a limit is a decision rather than a literal. */
export const THROTTLES = {
  /**
   * Gym registration. Generous, because a real gym owner may try three or
   * four times with a password their manager rejects, and because signups
   * from one office or one phone network share an address.
   */
  registration: {
    bucket: 'registration',
    limit: 10,
    windowMinutes: 60,
    message:
      'Several gyms have been registered from this connection recently. ' +
      'Please try again in an hour, or get in touch and we will set it up with you.',
  },
  /** Asking for a member sign-in code, per address rather than per number. */
  memberCodeRequest: {
    bucket: 'member-code',
    limit: 20,
    windowMinutes: 60,
    message: 'Too many sign-in codes requested from this connection. Try again later.',
  },
  /** Password reset requests, which send email on somebody else's behalf. */
  passwordReset: {
    bucket: 'password-reset',
    limit: 15,
    windowMinutes: 60,
    message: 'Too many reset requests from this connection. Try again later.',
  },
} as const;
