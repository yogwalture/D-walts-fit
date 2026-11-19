/**
 * Limits on the endpoints anybody can reach.
 *
 * Registration was the one that mattered: public, unauthenticated, and it
 * creates a tenant with a dozen rows in it. Nothing limited it at all, so a
 * single script could have filled the database on a shared host — and the
 * first anyone would have known is a disk full.
 *
 * The honest scope of all this is tested too: it stops one script hammering
 * one endpoint. A flood from a thousand addresses is an edge problem, and
 * these tests do not pretend otherwise.
 */

import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  requestPasswordReset,
  throttle,
  throttleRemaining,
  purgeThrottleHits,
  runHousekeeping,
  housekeepingPending,
  THROTTLES,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];
const usedBuckets: string[] = [];

function bucket(name: string): string {
  const scoped = `test-${name}-${unique()}`;
  usedBuckets.push(scoped);
  return scoped;
}

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.throttleHit.deleteMany({ where: { bucket: { in: usedBuckets } } });
  await db.$disconnect();
});

// =========================================================================

describe('the counter itself', () => {
  it('allows the limit and refuses the one after it', async () => {
    const rule = {
      bucket: bucket('basic'),
      key: '198.51.100.1',
      limit: 3,
      windowMinutes: 60,
      message: 'Enough.',
    };

    await throttle(db, rule);
    await throttle(db, rule);
    await throttle(db, rule);
    await expect(throttle(db, rule)).rejects.toThrow(AppError);
  });

  it('counts a refused request, so sitting on the limit does not reset it', async () => {
    const rule = {
      bucket: bucket('persistent'),
      key: '198.51.100.2',
      limit: 1,
      windowMinutes: 60,
      message: 'Enough.',
    };

    await throttle(db, rule);
    await expect(throttle(db, rule)).rejects.toThrow(AppError);
    // The refusal above was itself recorded. If it were not, somebody
    // parked on the limit would get a fresh allowance every rejection and
    // the limit would never actually bite.
    await expect(throttle(db, rule)).rejects.toThrow(AppError);

    const hits = await db.throttleHit.count({ where: { bucket: rule.bucket } });
    expect(hits).toBe(3);
  });

  it('counts each key separately, so one abuser does not block a street', async () => {
    const shared = bucket('per-key');
    const rule = { bucket: shared, limit: 1, windowMinutes: 60, message: 'Enough.' };

    await throttle(db, { ...rule, key: '198.51.100.3' });
    await expect(throttle(db, { ...rule, key: '198.51.100.3' })).rejects.toThrow(AppError);
    // A different address is unaffected.
    await expect(throttle(db, { ...rule, key: '198.51.100.4' })).resolves.toBeUndefined();
  });

  it('ignores hits that have fallen out of the window', async () => {
    const scoped = bucket('window');
    const rule = { bucket: scoped, key: '198.51.100.5', limit: 2, windowMinutes: 60, message: 'x' };

    // Two hits, aged past the window by hand.
    await db.throttleHit.createMany({
      data: [
        { bucket: scoped, key: rule.key, occurredAt: new Date(Date.now() - 120 * 60_000) },
        { bucket: scoped, key: rule.key, occurredAt: new Date(Date.now() - 90 * 60_000) },
      ],
    });

    await expect(throttle(db, rule)).resolves.toBeUndefined();
    expect(await throttleRemaining(db, rule)).toBe(1);
  });

  it('lets a request through when there is no address to attribute it to', async () => {
    const rule = {
      bucket: bucket('no-key'),
      key: undefined,
      limit: 0,
      windowMinutes: 60,
      message: 'x',
    };

    // A limit of zero and it still passes: one proxy that strips the
    // forwarded header must not block every signup on the platform.
    await expect(throttle(db, rule)).resolves.toBeUndefined();
  });

  it('clears hits old enough to be useless', async () => {
    const scoped = bucket('purge');
    await db.throttleHit.createMany({
      data: [
        { bucket: scoped, key: 'a', occurredAt: new Date(Date.now() - 48 * 3_600_000) },
        { bucket: scoped, key: 'a', occurredAt: new Date() },
      ],
    });

    await purgeThrottleHits(db, 24);

    const left = await db.throttleHit.count({ where: { bucket: scoped } });
    expect(left).toBe(1);
  });
});

// =========================================================================

describe('registering a gym', () => {
  const ip = `198.51.100.${Math.floor(Math.random() * 90) + 100}`;

  beforeEach(async () => {
    await db.throttleHit.deleteMany({ where: { bucket: 'registration', key: ip } });
  });

  async function register(index: number) {
    const email = `throttle.${unique()}.${index}@example.com`;
    createdEmails.push(email);

    const created = await registerGym({
      gymName: `Throttle Gym ${unique()}`,
      ownerName: 'Throttle Owner',
      email,
      phone: `98${String(Date.now() + index).slice(-8)}`,
      password: 'correct horse battery staple 47',
      planKey: 'STARTER' as never,
      acceptedTerms: true,
      ipAddress: ip,
    });
    createdOrgIds.push(created.organizationId);
    return created;
  }

  it('refuses the eleventh gym from one connection in an hour', async () => {
    for (let index = 0; index < THROTTLES.registration.limit; index += 1) {
      await register(index);
    }

    await expect(register(99)).rejects.toThrow(AppError);
  }, 120_000);

  it('says something a real gym owner can act on', async () => {
    await db.throttleHit.createMany({
      data: Array.from({ length: THROTTLES.registration.limit + 1 }, () => ({
        bucket: 'registration',
        key: ip,
      })),
    });

    const error = await register(0).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    const message = (error as AppError).message;
    // Not "rate limited", and not the number — a limit stated is a limit
    // somebody tunes their script to.
    expect(message).toContain('try again in an hour');
    expect(message).toContain('get in touch');
    expect(message).not.toMatch(/\d+ (?:requests|attempts)/);
  });

  it('creates nothing at all when it refuses', async () => {
    await db.throttleHit.createMany({
      data: Array.from({ length: THROTTLES.registration.limit + 1 }, () => ({
        bucket: 'registration',
        key: ip,
      })),
    });

    const before = await db.organization.count();
    await register(0).catch(() => undefined);
    const after = await db.organization.count();

    // The throttle runs before anything is written, so a refused signup
    // leaves no half-made tenant behind.
    expect(after).toBe(before);
  });
});

// =========================================================================

describe('asking for a password reset', () => {
  it('is limited per connection, not only per email address', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 90) + 100}`;
    await db.throttleHit.deleteMany({ where: { bucket: 'password-reset', key: ip } });

    // Each request names a different address, so the per-email cooldown
    // never fires. Without a per-connection limit this is a way to send
    // mail in our name to a list.
    for (let index = 0; index < THROTTLES.passwordReset.limit; index += 1) {
      await requestPasswordReset(authPrisma, {
        email: `nobody.${unique()}@example.com`,
        ipAddress: ip,
      });
    }

    await expect(
      requestPasswordReset(authPrisma, {
        email: `nobody.${unique()}@example.com`,
        ipAddress: ip,
      }),
    ).rejects.toThrow(AppError);

    await db.throttleHit.deleteMany({ where: { bucket: 'password-reset', key: ip } });
  }, 60_000);

  /**
   * The existing per-email cooldown is not replaced by the per-connection
   * one: they stop different things, and the response still must not reveal
   * whether the address exists.
   */
  it('still answers the same way whether or not the account exists', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 50) + 10}`;
    await db.throttleHit.deleteMany({ where: { bucket: 'password-reset', key: ip } });

    const unknown = await requestPasswordReset(authPrisma, {
      email: `ghost.${unique()}@example.com`,
      ipAddress: ip,
    });

    expect(unknown.token).toBeUndefined();
    await db.throttleHit.deleteMany({ where: { bucket: 'password-reset', key: ip } });
  });
});

// =========================================================================

describe('the daily tidy-up', () => {
  /**
   * `purgeExpiredTokens` was written with a comment saying it was "run by
   * the daily session-and-token job", and no such job existed. These tests
   * are what makes that comment true.
   */
  it('removes an expired sign-in code and leaves a live one alone', async () => {
    const live = `housekeeping.live.${unique()}@example.com`;
    const dead = `housekeeping.dead.${unique()}@example.com`;

    await db.verificationToken.createMany({
      data: [
        {
          type: 'PASSWORD_RESET',
          tokenHash: `live-${unique()}`,
          email: live,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        {
          type: 'PASSWORD_RESET',
          tokenHash: `dead-${unique()}`,
          email: dead,
          expiresAt: new Date(Date.now() - 3_600_000),
        },
      ],
    });

    await runHousekeeping(db);

    expect(await db.verificationToken.count({ where: { email: dead } })).toBe(0);
    expect(await db.verificationToken.count({ where: { email: live } })).toBe(1);

    await db.verificationToken.deleteMany({ where: { email: { in: [live, dead] } } });
  });

  it('keeps a recent login attempt and clears an ancient one', async () => {
    const email = `housekeeping.${unique()}@example.com`;

    await db.loginAttempt.createMany({
      data: [
        { email, ipAddress: '198.51.100.9', succeeded: false, attemptedAt: new Date() },
        {
          email,
          ipAddress: '198.51.100.9',
          succeeded: false,
          attemptedAt: new Date(Date.now() - 60 * 864e5),
        },
      ],
    });

    await runHousekeeping(db);

    const left = await db.loginAttempt.findMany({ where: { email } });
    expect(left).toHaveLength(1);
    // The one kept is the recent one — the throttle depends on those, and
    // deleting them would quietly disable the login limit.
    expect(left[0]!.attemptedAt.getTime()).toBeGreaterThan(Date.now() - 864e5);

    await db.loginAttempt.deleteMany({ where: { email } });
  });

  it('says what it would remove without removing it', async () => {
    const email = `housekeeping.dry.${unique()}@example.com`;
    await db.verificationToken.create({
      data: {
        type: 'PASSWORD_RESET',
        tokenHash: `dry-${unique()}`,
        email,
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });

    const pending = await housekeepingPending(db);
    expect(pending.expiredTokens).toBeGreaterThan(0);

    // Still there: a dry run that deletes is not a dry run.
    expect(await db.verificationToken.count({ where: { email } })).toBe(1);

    await db.verificationToken.deleteMany({ where: { email } });
  });

  it('reports whether another pass is needed', async () => {
    // Nothing like 5,000 rows of anything here, so one pass finishes it.
    const result = await runHousekeeping(db);
    expect(result.moreToDo).toBe(false);
    expect(typeof result.expiredTokens).toBe('number');
    expect(typeof result.oldThrottleHits).toBe('number');
  });
});
