/**
 * Contracts against the schema.
 *
 * Writing the Zod schemas by hand let seven of them drift from the database
 * in one sitting — an invented `BIOMETRIC` check-in method, a `NETBANKING`
 * payment method the enum does not have, a filter the service cannot apply.
 * Each would have type-checked at the boundary and failed at runtime.
 *
 * So the enums are compared to Prisma's generated ones, which come from the
 * schema itself. A new value in the schema and a forgotten contract is a
 * failing test rather than a 500 at the counter.
 */

import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  checkInMethod,
  counterPaymentMethod,
  paymentMethod,
  recordPaymentInput,
  memberListQuery,
  dashboardQuery,
  checkInInput,
  sellMembershipInput,
  money,
  phone,
  boolish,
  timetableQuery,
} from '@gym/contracts';

const schemaEnum = (name: string): string[] => {
  const found = Prisma.dmmf.datamodel.enums.find((e) => e.name === name);
  if (!found) throw new Error(`No enum ${name} in the schema`);
  return found.values.map((v) => v.name).sort();
};

describe('contract enums match the schema', () => {
  it('payment methods are exactly the schema’s', () => {
    expect([...paymentMethod.options].sort()).toEqual(schemaEnum('PaymentMethod'));
  });

  it('check-in methods are exactly the schema’s', () => {
    expect([...checkInMethod.options].sort()).toEqual(schemaEnum('AttendanceMethod'));
  });

  it('the counter cannot claim a gateway payment', () => {
    // The whole point: only the verified webhook may bank a Razorpay payment.
    expect(counterPaymentMethod.options).not.toContain('RAZORPAY');
    expect(paymentMethod.options).toContain('RAZORPAY');

    const rejected = recordPaymentInput.safeParse({
      memberId: '11111111-1111-4111-8111-111111111111',
      amount: '1500.00',
      method: 'RAZORPAY',
    });
    expect(rejected.success).toBe(false);

    // ...while the sale may create one, as PENDING.
    const accepted = sellMembershipInput.safeParse({
      memberId: '11111111-1111-4111-8111-111111111111',
      planId: '22222222-2222-4222-8222-222222222222',
      payment: { amount: '1500.00', method: 'RAZORPAY' },
    });
    expect(accepted.success).toBe(true);
  });
});

describe('permission keys', () => {
  /**
   * Every key the code checks must exist in the registry.
   *
   * `finance.expense.create` did not — the service invented it, the
   * registry had `finance.expense.manage`, and the result was a gym owner
   * who could not record an expense in their own gym. Nothing in the
   * typechecker can catch a string that does not match another string, so
   * this does.
   */
  it('are all in the registry', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { PrismaClient } = await import('@prisma/client');

    const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
    const registry = new Set(
      (await db.permission.findMany({ select: { key: true } })).map((row) => row.key),
    );
    await db.$disconnect();

    expect(registry.size, 'the registry is seeded').toBeGreaterThan(100);

    const roots = ['packages/core/src', 'apps/web/app', 'apps/web/lib'];
    const files: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    for (const root of roots) walk(root);

    // Keys as the code writes them: requirePermission(x, 'a.b.c'),
    // scopeOf(x, 'a.b.c'), permission: 'a.b.c', holds(session, 'a.b.c').
    const pattern =
      /(?:requirePermission|requireAnyPermission|scopeOf|branchFilter|holds)\([^)]*?['"]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)['"]|permission:\s*['"]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)['"]/g;

    const used = new Map<string, string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const key = match[1] ?? match[2];
        if (key && !used.has(key)) used.set(key, file);
      }
    }

    expect(used.size, 'found permission checks to verify').toBeGreaterThan(20);

    const invented = [...used.entries()]
      .filter(([key]) => !registry.has(key))
      .map(([key, file]) => `${key} (${file})`);

    expect(invented, 'every permission the code checks must be in the registry').toEqual([]);
  });
});

describe('input coercion', () => {
  it('normalises Indian mobile numbers however they are typed', () => {
    for (const input of ['9876543210', '+919876543210', '09876543210', '98765 43210', '98765-43210']) {
      expect(phone.parse(input)).toBe('9876543210');
    }
    for (const bad of ['1234567890', '98765', 'abcdefghij', '919876543210000']) {
      expect(phone.safeParse(bad).success, `${bad} should be rejected`).toBe(false);
    }
  });

  it('keeps a real number that happens to start with 91', () => {
    // 9112…, 9145… and the rest are live Indian mobile series. Stripping a
    // leading 91 unconditionally left eight digits and rejected the member
    // outright — they could not be registered, found or signed in.
    for (const real of ['9112907620', '9145678901', '9198765432']) {
      expect(phone.parse(real), `${real} should survive`).toBe(real);
    }

    // The country code is still removed when it is actually a country code.
    expect(phone.parse('919876543210')).toBe('9876543210');
    expect(phone.parse('+91 91129 07620')).toBe('9112907620');
    expect(phone.parse('09112907620')).toBe('9112907620');
  });

  /**
   * A query flag that means the opposite of what it says.
   *
   * `z.coerce.boolean()` applies JavaScript truthiness, so the string
   * "false" — which is what a query string carries — came out as `true`.
   * Three live flags were inverted by it: the audit log's `platformOnly`,
   * the gym list's `withStats`, and the class list's `includeCancelled`.
   * Nothing errored; the answers were just wrong.
   */
  it('reads a boolean flag the way a query string writes it', () => {
    expect(boolish.parse('false')).toBe(false);
    expect(boolish.parse('true')).toBe(true);
    expect(boolish.parse('0')).toBe(false);
    expect(boolish.parse('1')).toBe(true);
    expect(boolish.parse('no')).toBe(false);
    expect(boolish.parse('')).toBe(false);
    // A real boolean from a JSON body still works.
    expect(boolish.parse(false)).toBe(false);
    expect(boolish.parse(true)).toBe(true);
    // And nonsense is refused rather than guessed at.
    expect(() => boolish.parse('maybe')).toThrow();
  });

  it('refuses a boolean flag nothing can mean', () => {
    const schema = timetableQuery;
    expect(() => schema.parse({ includeCancelled: 'perhaps' })).toThrow();
    // The one that was actually broken, end to end through a real schema.
    expect(schema.parse({ includeCancelled: 'false' }).includeCancelled).toBe(false);
  });

  it('accepts money as a string or a number and stores two decimals', () => {
    expect(money.parse('1500')).toBe('1500');
    expect(money.parse(1500)).toBe('1500.00');
    expect(money.parse(1500.5)).toBe('1500.50');
    expect(money.safeParse('1500.555').success).toBe(false);
    expect(money.safeParse('abc').success).toBe(false);
  });

  it('defaults a list query so no endpoint can return a whole table', () => {
    const parsed = memberListQuery.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(25);
    expect(parsed.filter).toBe('all');
    // The cap is what keeps a request inside Hostinger's 120-second limit.
    expect(memberListQuery.safeParse({ pageSize: 5000 }).success).toBe(false);
  });
});

describe('cross-field rules', () => {
  it('a custom date range needs both dates, in order', () => {
    expect(dashboardQuery.safeParse({ range: 'custom' }).success).toBe(false);
    expect(
      dashboardQuery.safeParse({ range: 'custom', fromDate: '2026-11-01', toDate: '2026-11-30' })
        .success,
    ).toBe(true);
    expect(
      dashboardQuery.safeParse({ range: 'custom', fromDate: '2026-11-30', toDate: '2026-11-01' })
        .success,
    ).toBe(false);
    // A named range needs nothing else.
    expect(dashboardQuery.parse({}).range).toBe('last30');
  });

  it('a check-in must identify somebody', () => {
    expect(checkInInput.safeParse({}).success).toBe(false);
    expect(checkInInput.safeParse({ memberCode: 'M00001' }).success).toBe(true);
    expect(checkInInput.safeParse({ qrToken: 'a'.repeat(32) }).success).toBe(true);
  });

  it('an override must carry its reason', () => {
    expect(checkInInput.safeParse({ memberCode: 'M00001', override: true }).success).toBe(false);
    expect(
      checkInInput.safeParse({ memberCode: 'M00001', override: true, overrideReason: 'Paying now' })
        .success,
    ).toBe(true);
  });

  it('an extension and a cancellation cannot be done without a reason', async () => {
    const { extendInput, cancelInput } = await import('@gym/contracts');
    expect(extendInput.safeParse({ subscriptionId: crypto.randomUUID(), days: 7 }).success).toBe(
      false,
    );
    expect(
      cancelInput.safeParse({ subscriptionId: crypto.randomUUID(), reason: '' }).success,
    ).toBe(false);
  });
});
