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

describe('input coercion', () => {
  it('normalises Indian mobile numbers however they are typed', () => {
    for (const input of ['9876543210', '+919876543210', '09876543210', '98765 43210', '98765-43210']) {
      expect(phone.parse(input)).toBe('9876543210');
    }
    for (const bad of ['1234567890', '98765', 'abcdefghij', '919876543210000']) {
      expect(phone.safeParse(bad).success, `${bad} should be rejected`).toBe(false);
    }
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
