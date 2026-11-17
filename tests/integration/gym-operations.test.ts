/**
 * Phase 2: members, plans, the subscription lifecycle, GST invoicing,
 * payments and attendance — against a real database, on the application role.
 *
 * The money and date arithmetic is tested hardest, because that is where a
 * bug costs a real gym real rupees and nobody notices for a month.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma, getJobsClient } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  findDuplicates,
  listMembers,
  getMember,
  updateMember,
  archiveMember,
  createPlan,
  listPlans,
  quotePlan,
  sellMembership,
  freezeSubscription,
  unfreezeSubscription,
  extendSubscription,
  cancelSubscription,
  expireSubscriptions,
  issueMemberQr,
  checkIn,
  checkOut,
  todaysAttendance,
  peakHours,
  recordPayment,
  applyVerifiedGatewayPayment,
  dailyCollection,
  getDashboardSummary,
  getCharts,
  getActionLists,
  resolvePermissions,
  // helpers
  toPaise,
  toRupees,
  splitTax,
  endDateFor,
  inclusiveDays,
  addMonths,
  addDays,
  today,
  financialYear,
  AppError,
} from '@gym/core';
import { verifyWebhookSignature, parseWebhook } from '@gym/integrations';
import { createHmac } from 'node:crypto';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const authDb = authPrisma;

const unique = () => Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple 47';

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolvePermissions>>;
let taxRateId: string;
let monthlyPlanId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Money, at two decimal places.
 *
 * Prisma hands back a Decimal whose toString() drops trailing zeros, so
 * `1500.00` arrives as "1500". Comparing the raw string would be testing the
 * formatter; this compares the amount.
 */
const rs = (value: unknown) => Number(value).toFixed(2);

beforeAll(async () => {
  const email = `ops.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Ops Gym ${unique()}`,
    ownerName: 'Ops Owner',
    email,
    phone: '9876520000',
    password: PASSWORD,
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authDb, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authDb, session.token)).actor.permissions;

  const rate = await db.taxRate.findFirstOrThrow({
    where: { organizationId: gym.organizationId },
  });
  taxRateId = rate.id;

  const plan = await createPlan(ctx, owner, {
    name: 'Monthly',
    durationUnit: 'MONTH',
    durationValue: 1,
    price: '1500.00',
    taxRateId,
    priceIncludesTax: true,
    graceDays: 3,
    freezeAllowed: true,
    freezeMaxDays: 15,
    transferAllowed: true,
  });
  monthlyPlanId = plan.id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

async function newMember(overrides: Record<string, unknown> = {}) {
  return createMember(ctx, owner, {
    firstName: 'Test',
    lastName: unique(),
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    ...overrides,
  } as never);
}

// =========================================================================
//  Money and dates — pure, and the most expensive place to be wrong
// =========================================================================

describe('money', () => {
  it('converts rupees to paise and back without drift', () => {
    for (const value of ['0.00', '1.00', '1500.00', '1271.19', '0.01', '99999.99']) {
      expect(toRupees(toPaise(value))).toBe(value);
    }
    expect(toPaise('1500')).toBe(150000);
    expect(toPaise(1500.5)).toBe(150050);
    expect(toPaise('-250.75')).toBe(-25075);
    expect(toRupees(-25075)).toBe('-250.75');
  });

  it('never loses a paisa to floating point', () => {
    // 0.1 + 0.2 in floating point is famously not 0.3.
    expect(toRupees(toPaise('0.10') + toPaise('0.20'))).toBe('0.30');

    let total = 0;
    for (let i = 0; i < 1000; i += 1) total += toPaise('0.07');
    expect(toRupees(total)).toBe('70.00');
  });

  it('backs tax out of a tax-inclusive price, which is how gyms quote', () => {
    const rate = { percentage: '18', components: { cgst: 9, sgst: 9 } };
    const tax = splitTax(toPaise('1500.00'), rate, { inclusive: true });

    expect(toRupees(tax.total)).toBe('1500.00');
    expect(toRupees(tax.taxable)).toBe('1271.19');
    expect(toRupees(tax.tax)).toBe('228.81');
    expect(tax.taxable + tax.tax).toBe(tax.total);
  });

  it('adds tax on top when the price excludes it', () => {
    const rate = { percentage: '18', components: { cgst: 9, sgst: 9 } };
    const tax = splitTax(toPaise('1000.00'), rate, { inclusive: false });

    expect(toRupees(tax.taxable)).toBe('1000.00');
    expect(toRupees(tax.tax)).toBe('180.00');
    expect(toRupees(tax.total)).toBe('1180.00');
  });

  it('splits CGST and SGST so the parts always sum to the whole', () => {
    const rate = { percentage: '18', components: { cgst: 9, sgst: 9 } };

    // An amount that does not divide evenly is where naive rounding breaks:
    // CGST + SGST must still equal the tax exactly, or the GST return fails.
    for (const amount of ['1500.00', '999.99', '1.00', '333.33', '7777.77']) {
      const tax = splitTax(toPaise(amount), rate);
      const parts = Object.values(tax.components).reduce((sum, part) => sum + part, 0);
      expect(parts, `components must sum to tax for ${amount}`).toBe(tax.tax);
      expect(tax.taxable + tax.tax).toBe(tax.total);
    }
  });

  it('treats a missing or zero rate as no tax at all', () => {
    expect(splitTax(toPaise('500.00'), null).tax).toBe(0);
    expect(splitTax(toPaise('500.00'), { percentage: 0 }).taxable).toBe(toPaise('500.00'));
  });
});

describe('dates', () => {
  it('ends a one-month membership on the last day the member may train', () => {
    // 1 November + 1 month = 30 November, inclusive. Not 1 December.
    expect(iso(endDateFor(new Date('2026-11-01'), 'MONTH', 1))).toBe('2026-11-30');
    expect(iso(endDateFor(new Date('2026-01-01'), 'MONTH', 1))).toBe('2026-01-31');
    expect(iso(endDateFor(new Date('2026-01-01'), 'YEAR', 1))).toBe('2026-12-31');
    expect(iso(endDateFor(new Date('2026-11-10'), 'DAY', 1))).toBe('2026-11-10');
    expect(iso(endDateFor(new Date('2026-11-10'), 'WEEK', 1))).toBe('2026-11-16');
  });

  it('clamps to the end of a short month instead of rolling over', () => {
    // 31 January + 1 month is 28 February, not 3 March. Rolling over would
    // quietly hand out extra days on every renewal from a long month.
    expect(iso(addMonths(new Date('2026-01-31'), 1))).toBe('2026-02-28');
    expect(iso(addMonths(new Date('2028-01-31'), 1))).toBe('2028-02-29');
    expect(iso(addMonths(new Date('2026-03-31'), 1))).toBe('2026-04-30');
    expect(iso(endDateFor(new Date('2026-01-31'), 'MONTH', 1))).toBe('2026-02-27');
  });

  it('counts days inclusively', () => {
    expect(inclusiveDays(new Date('2026-11-01'), new Date('2026-11-30'))).toBe(30);
    expect(inclusiveDays(new Date('2026-11-01'), new Date('2026-11-01'))).toBe(1);
  });

  it('uses the Indian financial year, April to March', () => {
    expect(financialYear(new Date('2026-11-17'))).toBe('2026-27');
    expect(financialYear(new Date('2026-03-31'))).toBe('2025-26');
    expect(financialYear(new Date('2026-04-01'))).toBe('2026-27');
  });
});

// =========================================================================
//  Members
// =========================================================================

describe('members', () => {
  it('allocates sequential member codes with the gym’s prefix', async () => {
    const a = await newMember({ firstName: 'Code', lastName: 'One' });
    const b = await newMember({ firstName: 'Code', lastName: 'Two' });

    expect(a.memberCode).toMatch(/^M\d{5}$/);
    expect(Number(b.memberCode.slice(1))).toBe(Number(a.memberCode.slice(1)) + 1);
  });

  it('warns about a duplicate phone number instead of creating a second record', async () => {
    const phone = '9876598765';
    await newMember({ firstName: 'First', phone });

    const error = await createMember(ctx, owner, {
      firstName: 'Second',
      phone,
    } as never).catch((e: AppError) => e);

    expect((error as AppError).code).toBe('DUPLICATE_MEMBER');
    expect((error as AppError).details?.[0]?.field).toBe('phone');

    // Families share numbers, so reception can proceed deliberately.
    const forced = await createMember(ctx, owner, {
      firstName: 'Second',
      phone,
      allowDuplicate: true,
    } as never);
    expect(forced.duplicatesAcknowledged).toBeGreaterThan(0);

    const matches = await findDuplicates(ctx, { phone });
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by membership state', async () => {
    const all = await listMembers(ctx, owner, { filter: 'all', pageSize: 100 });
    expect(all.total).toBeGreaterThan(0);

    const active = await listMembers(ctx, owner, { filter: 'active' });
    const expired = await listMembers(ctx, owner, { filter: 'expired' });
    expect(active.total + expired.total).toBeLessThanOrEqual(all.total);
  });

  it('searches by name, code and phone', async () => {
    const member = await newMember({ firstName: 'Searchable', lastName: 'Person' });
    const byName = await listMembers(ctx, owner, { search: 'Searchable' });
    const byCode = await listMembers(ctx, owner, { search: member.memberCode });

    expect(byName.rows.some((row) => row.id === member.id)).toBe(true);
    expect(byCode.rows.some((row) => row.id === member.id)).toBe(true);
  });

  it('does not fetch medical data for someone not entitled to it', async () => {
    const member = await newMember({ firstName: 'Medical' });
    await db.memberMedicalDeclaration.create({
      data: {
        organizationId: gym.organizationId,
        memberId: member.id,
        hasDeclaredConditions: true,
        conditions: ['Asthma'],
      },
    });

    const asOwner = await getMember(ctx, owner, member.id);
    expect(asOwner.canSeeMedical).toBe(true);
    expect((asOwner as any).medicalDeclaration?.conditions).toEqual(['Asthma']);

    const receptionRole = await db.role.findFirstOrThrow({
      where: { organizationId: null, key: 'RECEPTIONIST' },
      include: { permissions: { select: { permissionKey: true, scope: true } } },
    });
    const reception = resolvePermissions({
      roleKey: 'RECEPTIONIST',
      rolePermissions: receptionRole.permissions,
      overrides: [],
      branchIds: [],
      planFeatures: ['crm', 'classes', 'workouts', 'inventory', 'video', 'whatsapp'],
      isPlatformAdmin: false,
    });

    const asReception = await getMember(ctx, reception, member.id);
    expect(asReception.canSeeMedical).toBe(false);
    // Not fetched-then-hidden: the field is absent from the result entirely.
    expect('medicalDeclaration' in asReception).toBe(false);
  });

  it('archives rather than deletes, so the financial history survives', async () => {
    const member = await newMember({ firstName: 'Archive' });
    await archiveMember(ctx, owner, member.id, { reason: 'Moved away' });

    const row = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.status).toBe('CANCELLED');

    const visible = await listMembers(ctx, owner, { search: 'Archive' });
    expect(visible.rows.some((r) => r.id === member.id)).toBe(false);
  });
});

// =========================================================================
//  Plans and quoting
// =========================================================================

describe('plans', () => {
  it('quotes exactly what the sale will charge', async () => {
    const quote = await quotePlan(ctx, { planId: monthlyPlanId, startDate: '2026-11-01' });

    expect(quote.total).toBe('1500.00');
    expect(quote.taxable).toBe('1271.19');
    expect(quote.tax).toBe('228.81');
    expect(iso(quote.endDate)).toBe('2026-11-30');
    expect(iso(quote.graceUntil)).toBe('2026-12-03');
    expect(quote.durationLabel).toBe('1 month');
  });

  it('refuses a duplicate plan name', async () => {
    await expect(
      createPlan(ctx, owner, {
        name: 'Monthly',
        durationUnit: 'MONTH',
        durationValue: 1,
        price: '1200',
      }),
    ).rejects.toThrow(AppError);
  });

  it('requires a session count for a session package', async () => {
    await expect(
      createPlan(ctx, owner, {
        name: `PT ${unique()}`,
        durationUnit: 'SESSION',
        durationValue: 1,
        price: '6000',
      }),
    ).rejects.toThrow(AppError);
  });

  it('lists plans with their active subscription counts', async () => {
    const plans = await listPlans(ctx, owner);
    const monthly = plans.find((p) => p.id === monthlyPlanId);
    expect(monthly?.priceDisplay).toBe('₹1,500.00');
    expect(monthly?.durationLabel).toBe('1 month');
  });
});

// =========================================================================
//  Selling a membership — the transaction that matters most
// =========================================================================

describe('selling a membership', () => {
  it('writes the subscription, invoice, line and payment in one go', async () => {
    const member = await newMember({ firstName: 'Buyer' });

    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      startDate: '2026-11-01',
      payment: { amount: '1500.00', method: 'UPI', referenceNumber: '432198765432' },
    });

    expect(sale.total).toBe('1500.00');
    expect(sale.paid).toBe('1500.00');
    expect(sale.due).toBe('0.00');
    expect(sale.isRenewal).toBe(false);
    expect(sale.invoiceCode).toMatch(/^INV\/\d{4}-\d{2}\/\d{5}$/);
    expect(sale.receiptCode).toMatch(/^RCP\/\d{4}-\d{2}\/\d{5}$/);

    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: sale.invoiceId },
      include: { lines: true, payments: true },
    });

    expect(invoice.status).toBe('PAID');
    expect(rs(invoice.subtotal)).toBe('1271.19');
    expect(rs(invoice.taxAmount)).toBe('228.81');
    expect(rs(invoice.total)).toBe('1500.00');
    expect(rs(invoice.amountDue)).toBe('0.00');
    expect(invoice.lines).toHaveLength(1);
    expect(rs(invoice.lines[0]!.taxPercentage)).toBe('18.00');
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.payments[0]!.status).toBe('CAPTURED');

    // The member's denormalised fields are updated in the same transaction,
    // so the dashboard can count without joining.
    const updated = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(iso(updated.membershipExpiresAt!)).toBe('2026-11-30');
    expect(updated.activeSubscriptionId).toBe(sale.subscriptionId);
    expect(rs(updated.outstandingAmount)).toBe('0.00');

    // And the event history records how it got here.
    const events = await db.subscriptionEvent.findMany({
      where: { subscriptionId: sale.subscriptionId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('CREATED');
    expect(events[0]!.daysDelta).toBe(30);
  });

  it('bills without a payment and carries the amount as outstanding', async () => {
    const member = await newMember({ firstName: 'Credit' });

    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      startDate: '2026-11-01',
    });

    expect(sale.paid).toBe('0.00');
    expect(sale.due).toBe('1500.00');

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: sale.invoiceId } });
    expect(invoice.status).toBe('ISSUED');

    const updated = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(rs(updated.outstandingAmount)).toBe('1500.00');
  });

  it('accepts a part payment and tracks the balance', async () => {
    const member = await newMember({ firstName: 'Part' });

    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      payment: { amount: '500.00', method: 'CASH' },
    });

    expect(sale.due).toBe('1000.00');
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: sale.invoiceId } });
    expect(invoice.status).toBe('PARTIALLY_PAID');
  });

  it('refuses a payment larger than the amount due', async () => {
    const member = await newMember({ firstName: 'Overpay' });

    await expect(
      sellMembership(ctx, owner, {
        memberId: member.id,
        planId: monthlyPlanId,
        payment: { amount: '2000.00', method: 'CASH' },
      }),
    ).rejects.toThrow(AppError);
  });

  it('stacks a renewal onto the end of a live membership', async () => {
    const member = await newMember({ firstName: 'Renewer' });

    const first = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      startDate: '2026-11-01',
      payment: { amount: '1500.00', method: 'CASH' },
    });
    expect(iso(first.endDate)).toBe('2026-11-30');

    // Renewing early must not throw away the days already paid for.
    const second = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      payment: { amount: '1500.00', method: 'CASH' },
    });

    expect(second.isRenewal).toBe(true);
    expect(iso(second.startDate)).toBe('2026-12-01');
    expect(iso(second.endDate)).toBe('2026-12-31');

    const updated = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(iso(updated.membershipExpiresAt!)).toBe('2026-12-31');
  });

  it('issues gapless invoice numbers even when sales happen at once', async () => {
    const members = await Promise.all(
      Array.from({ length: 8 }, (_, i) => newMember({ firstName: `Rush${i}` })),
    );

    // Eight receptionists pressing "collect" in the same second. GST requires
    // sequential numbering without gaps or duplicates, and the row lock on
    // the counter is what delivers it.
    const sales = await Promise.all(
      members.map((member) =>
        sellMembership(ctx, owner, {
          memberId: member.id,
          planId: monthlyPlanId,
          payment: { amount: '1500.00', method: 'CASH' },
        }),
      ),
    );

    const numbers = sales
      .map((sale) => Number(sale.invoiceCode.split('/').at(-1)))
      .sort((a, b) => a - b);

    expect(new Set(numbers).size, 'no duplicate invoice numbers').toBe(numbers.length);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]! - numbers[i - 1]!, 'no gaps in the sequence').toBe(1);
    }
  });
});

// =========================================================================
//  The subscription lifecycle
// =========================================================================

describe('the subscription lifecycle', () => {
  async function soldMembership(startDate = '2026-11-01') {
    const member = await newMember({ firstName: 'Lifecycle' });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      startDate,
      payment: { amount: '1500.00', method: 'CASH' },
    });
    return { memberId: member.id, ...sale };
  }

  it('freezing credits the lost days to the end of the membership', async () => {
    const sale = await soldMembership();

    const frozen = await freezeSubscription(ctx, owner, {
      subscriptionId: sale.subscriptionId,
      fromDate: '2026-11-10',
      toDate: '2026-11-19',
      reason: 'Travelling',
    });

    expect(frozen.daysCredited).toBe(10);
    expect(iso(frozen.newEndDate)).toBe('2026-12-10');
    expect(frozen.freezeDaysRemaining).toBe(5);

    const member = await db.member.findUniqueOrThrow({ where: { id: sale.memberId } });
    expect(iso(member.membershipExpiresAt!)).toBe('2026-12-10');
  });

  it('enforces the freeze allowance across the whole membership, not per freeze', async () => {
    const sale = await soldMembership();

    await freezeSubscription(ctx, owner, {
      subscriptionId: sale.subscriptionId,
      fromDate: '2026-11-05',
      toDate: '2026-11-14',
    });
    await unfreezeSubscription(ctx, owner, { subscriptionId: sale.subscriptionId });

    // 10 of 15 days are gone; a second 10-day freeze must be refused.
    const error = await freezeSubscription(ctx, owner, {
      subscriptionId: sale.subscriptionId,
      fromDate: '2026-12-01',
      toDate: '2026-12-10',
    }).catch((e: AppError) => e);

    expect((error as AppError).code).toBe('CONFLICT');
    expect((error as AppError).publicMessage).toContain('5');
  });

  it('refuses to freeze a plan that does not allow it', async () => {
    const strict = await createPlan(ctx, owner, {
      name: `No Freeze ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1000',
      freezeAllowed: false,
    });
    const member = await newMember({ firstName: 'NoFreeze' });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: strict.id,
      payment: { amount: '1000.00', method: 'CASH' },
    });

    await expect(
      freezeSubscription(ctx, owner, {
        subscriptionId: sale.subscriptionId,
        fromDate: iso(today()),
        toDate: iso(addDays(today(), 3)),
      }),
    ).rejects.toThrow(AppError);
  });

  it('extending records a reason and refuses without one', async () => {
    const sale = await soldMembership();

    await expect(
      extendSubscription(ctx, owner, {
        subscriptionId: sale.subscriptionId,
        days: 7,
        reason: '',
      }),
    ).rejects.toThrow(AppError);

    const extended = await extendSubscription(ctx, owner, {
      subscriptionId: sale.subscriptionId,
      days: 7,
      reason: 'Goodwill for the lift being out',
    });
    expect(iso(extended.newEndDate)).toBe('2026-12-07');
  });

  it('cancelling with a refund writes a refund row and never edits the payment away', async () => {
    const sale = await soldMembership();

    const result = await cancelSubscription(ctx, owner, {
      subscriptionId: sale.subscriptionId,
      reason: 'Member relocated',
      refundAmount: '750.00',
    });

    expect(result.refundAmount).toBe('750.00');
    expect(result.refundId).not.toBeNull();

    const refund = await db.refund.findUniqueOrThrow({ where: { id: result.refundId! } });
    expect(rs(refund.amount)).toBe('750.00');
    expect(refund.status).toBe('APPROVED');

    // The original payment is still there, marked — not deleted or rewritten.
    const payment = await db.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    expect(rs(payment.amount)).toBe('1500.00');
    expect(payment.status).toBe('PARTIALLY_REFUNDED');

    const subscription = await db.subscription.findUniqueOrThrow({
      where: { id: sale.subscriptionId },
    });
    expect(subscription.status).toBe('CANCELLED');

    const member = await db.member.findUniqueOrThrow({ where: { id: sale.memberId } });
    expect(member.activeSubscriptionId).toBeNull();
    expect(member.status).toBe('INACTIVE');
  });

  it('refuses a refund larger than what was actually paid', async () => {
    const sale = await soldMembership();

    await expect(
      cancelSubscription(ctx, owner, {
        subscriptionId: sale.subscriptionId,
        reason: 'Test',
        refundAmount: '5000.00',
      }),
    ).rejects.toThrow(AppError);
  });

  it('expires memberships past their grace period, and is safe to run twice', async () => {
    const member = await newMember({ firstName: 'Lapsed' });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      startDate: '2026-01-01',
      payment: { amount: '1500.00', method: 'CASH' },
    });

    const jobs = getJobsClient();
    const first = await expireSubscriptions(jobs, { asOf: new Date('2026-06-01') });
    expect(first.expired).toBeGreaterThanOrEqual(1);

    const subscription = await db.subscription.findUniqueOrThrow({
      where: { id: sale.subscriptionId },
    });
    expect(subscription.status).toBe('EXPIRED');

    const updated = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(updated.status).toBe('INACTIVE');

    // Idempotent: the job runs hourly and must not churn rows it already did.
    const second = await expireSubscriptions(jobs, { asOf: new Date('2026-06-01') });
    const stillExpired = await db.subscription.findUniqueOrThrow({
      where: { id: sale.subscriptionId },
    });
    expect(stillExpired.status).toBe('EXPIRED');
    expect(second.expired).toBeLessThan(first.expired + 1);
  });
});

// =========================================================================
//  Attendance
// =========================================================================

describe('attendance', () => {
  async function activeMember(name = 'Visitor') {
    const member = await newMember({ firstName: name });
    await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
      startDate: iso(addDays(today(), -5)),
      payment: { amount: '1500.00', method: 'CASH' },
    });
    return member.id;
  }

  it('lets an active member in and records the visit', async () => {
    const memberId = await activeMember('Welcome');
    const result = await checkIn(ctx, owner, { memberId });

    expect(result.allowed).toBe(true);
    expect(result.message).toContain('Welcome');
    expect(result.membership?.planName).toBe('Monthly');
    expect(result.attendanceId).toBeDefined();

    const member = await db.member.findUniqueOrThrow({ where: { id: memberId } });
    expect(member.lastVisitAt).not.toBeNull();
  });

  it('refuses a second check-in the same day without erroring', async () => {
    const memberId = await activeMember('Twice');
    await checkIn(ctx, owner, { memberId });

    const second = await checkIn(ctx, owner, { memberId });
    expect(second.allowed).toBe(false);
    expect(second.refusal).toBe('ALREADY_CHECKED_IN');
    // Reception gets an answer, not an exception to interpret.
    expect(second.member.id).toBe(memberId);
  });

  it('two simultaneous scans produce exactly one attendance row', async () => {
    const memberId = await activeMember('Racer');

    const results = await Promise.all([
      checkIn(ctx, owner, { memberId }),
      checkIn(ctx, owner, { memberId }),
    ]);

    expect(results.filter((r) => r.allowed)).toHaveLength(1);

    const rows = await db.attendance.count({ where: { memberId } });
    expect(rows).toBe(1);
  });

  it('turns away a member with no membership', async () => {
    const member = await newMember({ firstName: 'NoPlan' });
    const result = await checkIn(ctx, owner, { memberId: member.id });

    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe('NO_MEMBERSHIP');
  });

  it('turns away an expired membership but admits one inside its grace period', async () => {
    const lapsed = await newMember({ firstName: 'Lapsed' });
    await sellMembership(ctx, owner, {
      memberId: lapsed.id,
      planId: monthlyPlanId,
      startDate: iso(addDays(today(), -60)),
      payment: { amount: '1500.00', method: 'CASH' },
    });

    const refused = await checkIn(ctx, owner, { memberId: lapsed.id });
    expect(refused.allowed).toBe(false);
    expect(refused.refusal).toBe('EXPIRED');

    // Grace: ended yesterday, 3 grace days on the plan.
    const grace = await newMember({ firstName: 'Grace' });
    await sellMembership(ctx, owner, {
      memberId: grace.id,
      planId: monthlyPlanId,
      startDate: iso(addDays(today(), -31)),
      payment: { amount: '1500.00', method: 'CASH' },
    });

    const admitted = await checkIn(ctx, owner, { memberId: grace.id });
    expect(admitted.allowed).toBe(true);
    expect(admitted.membership?.inGracePeriod).toBe(true);
    expect(admitted.message).toContain('renew');
  });

  it('an override needs a reason and is audited', async () => {
    const member = await newMember({ firstName: 'Override' });

    await expect(
      checkIn(ctx, owner, { memberId: member.id, override: true }),
    ).rejects.toThrow(AppError);

    const admitted = await checkIn(ctx, owner, {
      memberId: member.id,
      override: true,
      overrideReason: 'Paying at the desk in a moment',
    });

    expect(admitted.allowed).toBe(true);
    expect(admitted.overrideUsed).toBe(true);

    const audit = await db.auditLog.findFirst({
      where: { organizationId: gym.organizationId, action: 'attendance.override' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.summary).toContain('Paying at the desk');
  });

  it('checks in by QR, and re-issuing the code kills the old one', async () => {
    const memberId = await activeMember('QR');
    const first = await issueMemberQr(ctx, { memberId });

    expect(first.payload).toMatch(/^gymcloud:m:/);

    const admitted = await checkIn(ctx, owner, { qrToken: first.token });
    expect(admitted.allowed).toBe(true);
    expect(admitted.member.id).toBe(memberId);

    // A screenshotted code must stop working once a new one is issued.
    const second = await issueMemberQr(ctx, { memberId });
    expect(second.token).not.toBe(first.token);

    await expect(checkIn(ctx, owner, { qrToken: first.token })).rejects.toThrow(AppError);
  });

  it('records a checkout duration', async () => {
    const memberId = await activeMember('Duration');
    const entry = await checkIn(ctx, owner, { memberId });

    const result = await checkOut(ctx, owner, { attendanceId: entry.attendanceId! });
    expect(result.durationMinutes).toBeGreaterThanOrEqual(1);
  });

  it('lists today and reports peak hours', async () => {
    const list = await todaysAttendance(ctx, owner);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('name');

    const hours = await peakHours(ctx, owner, {
      fromDate: iso(addDays(today(), -7)),
      toDate: iso(today()),
    });
    expect(hours).toHaveLength(24);
    expect(hours.reduce((sum, h) => sum + h.visits, 0)).toBeGreaterThan(0);
  });
});

// =========================================================================
//  Payments and the gateway
// =========================================================================

describe('payments', () => {
  it('settles an outstanding invoice and clears the member’s balance', async () => {
    const member = await newMember({ firstName: 'Settle' });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
    });

    const result = await recordPayment(ctx, owner, {
      memberId: member.id,
      invoiceId: sale.invoiceId,
      subscriptionId: sale.subscriptionId,
      amount: '1500.00',
      method: 'UPI',
      referenceNumber: '987654321012',
    });

    expect(result.invoiceStatus).toBe('PAID');
    expect(result.receiptCode).toMatch(/^RCP\//);

    const updated = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(rs(updated.outstandingAmount)).toBe('0.00');
  });

  it('refuses to take more than the invoice owes', async () => {
    const member = await newMember({ firstName: 'TooMuch' });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
    });

    await expect(
      recordPayment(ctx, owner, {
        memberId: member.id,
        invoiceId: sale.invoiceId,
        amount: '2000.00',
        method: 'CASH',
      }),
    ).rejects.toThrow(AppError);
  });

  it('reports the day’s collection split by method', async () => {
    const collection = await dailyCollection(ctx, owner);
    expect(Number(collection.total)).toBeGreaterThan(0);
    expect(collection.byMethod.length).toBeGreaterThan(0);
  });
});

describe('the Razorpay gateway', () => {
  const config = {
    keyId: 'rzp_test_example',
    keySecret: 'test_secret',
    webhookSecret: 'webhook_secret',
  };

  const sign = (body: string, secret = config.webhookSecret) =>
    createHmac('sha256', secret).update(body).digest('hex');

  it('verifies a webhook signature over the raw body', () => {
    const body = JSON.stringify({ event: 'payment.captured' });

    expect(verifyWebhookSignature(config, body, sign(body))).toBe(true);
    expect(verifyWebhookSignature(config, body, sign(body, 'wrong_secret'))).toBe(false);
    expect(verifyWebhookSignature(config, body, 'deadbeef')).toBe(false);

    // Re-serialised JSON has a different byte sequence and must not verify:
    // this is why the raw body is captured before parsing.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhookSignature(config, reserialised, sign(body))).toBe(false);
  });

  it('refuses to parse an event whose signature does not verify', () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    expect(() => parseWebhook(config, body, 'nonsense')).toThrow();
    expect(() => parseWebhook(config, body, null)).toThrow();
  });

  it('captures a payment only once, however many times the webhook arrives', async () => {
    const member = await newMember({ firstName: 'Gateway' });
    const sale = await sellMembership(ctx, owner, {
      memberId: member.id,
      planId: monthlyPlanId,
    });

    // A pending gateway payment, as the order-creation step would leave it.
    const orderId = `order_${unique()}`;
    await db.payment.create({
      data: {
        organizationId: gym.organizationId,
        memberId: member.id,
        invoiceId: sale.invoiceId,
        subscriptionId: sale.subscriptionId,
        amount: '1500.00',
        method: 'RAZORPAY',
        status: 'PENDING',
        razorpayOrderId: orderId,
      },
    });

    const jobs = getJobsClient();
    const first = await applyVerifiedGatewayPayment(jobs, {
      organizationId: gym.organizationId,
      razorpayPaymentId: `pay_${unique()}`,
      razorpayOrderId: orderId,
      amountPaise: 150000,
      method: 'upi',
    });
    expect(first.applied).toBe(true);

    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: sale.invoiceId } });
    expect(invoice.status).toBe('PAID');

    // Razorpay retries. A second delivery must change nothing.
    const second = await applyVerifiedGatewayPayment(jobs, {
      organizationId: gym.organizationId,
      razorpayPaymentId: `pay_${unique()}`,
      razorpayOrderId: orderId,
      amountPaise: 150000,
    });
    expect(second.reason).toBe('already_captured');

    const after = await db.invoice.findUniqueOrThrow({ where: { id: sale.invoiceId } });
    expect(rs(after.amountPaid)).toBe('1500.00');

    const payments = await db.payment.count({ where: { razorpayOrderId: orderId } });
    expect(payments).toBe(1);
  });

  it('refuses an amount that does not match the order', async () => {
    const member = await newMember({ firstName: 'Tamper' });
    const orderId = `order_${unique()}`;

    await db.payment.create({
      data: {
        organizationId: gym.organizationId,
        memberId: member.id,
        amount: '1500.00',
        method: 'RAZORPAY',
        status: 'PENDING',
        razorpayOrderId: orderId,
      },
    });

    const result = await applyVerifiedGatewayPayment(getJobsClient(), {
      organizationId: gym.organizationId,
      razorpayPaymentId: `pay_${unique()}`,
      razorpayOrderId: orderId,
      amountPaise: 100,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('amount_mismatch');
  });

  it('refuses a webhook aimed at another gym’s order', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const member = await newMember({ firstName: 'Crosser' });
    const orderId = `order_${unique()}`;

    await db.payment.create({
      data: {
        organizationId: gym.organizationId,
        memberId: member.id,
        amount: '1500.00',
        method: 'RAZORPAY',
        status: 'PENDING',
        razorpayOrderId: orderId,
      },
    });

    const result = await applyVerifiedGatewayPayment(getJobsClient(), {
      organizationId: otherOrg.id,
      razorpayPaymentId: `pay_${unique()}`,
      razorpayOrderId: orderId,
      amountPaise: 150000,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('tenant_mismatch');
  });
});

// =========================================================================
//  Dashboard
// =========================================================================

describe('the dashboard', () => {
  it('counts the gym’s own records and nothing else', async () => {
    const summary = await getDashboardSummary(ctx, owner, { range: 'last30' });

    expect(summary.members.total).toBeGreaterThan(0);
    expect(Number(summary.money.collectedInRange)).toBeGreaterThan(0);
    expect(summary.attendance.today).toBeGreaterThan(0);
    expect(summary.range.label).toBe('Last 30 days');

    // The other demo gym's figures must not appear here.
    const ironTemple = await db.organization.findFirstOrThrow({
      where: { slug: 'iron-temple' },
    });
    const theirMembers = await db.member.count({
      where: { organizationId: ironTemple.id, deletedAt: null },
    });
    const ourMembers = await db.member.count({
      where: { organizationId: gym.organizationId, deletedAt: null },
    });
    expect(summary.members.total).toBe(ourMembers);
    expect(summary.members.total).not.toBe(ourMembers + theirMembers);
  });

  it('fills empty months in the charts rather than skipping them', async () => {
    const charts = await getCharts(ctx, owner, { months: 6 });

    expect(charts.revenue).toHaveLength(6);
    expect(charts.attendance).toHaveLength(6);
    expect(charts.joins).toHaveLength(6);
    // Every month is present, including quiet ones at zero — a gap would
    // mislead the eye about the trend.
    expect(charts.revenue.every((p) => typeof p.value === 'number')).toBe(true);
    expect(charts.planMix.length).toBeGreaterThan(0);
  });

  it('produces the call lists a gym actually works from', async () => {
    const lists = await getActionLists(ctx, owner);

    expect(Array.isArray(lists.expiringSoon)).toBe(true);
    expect(Array.isArray(lists.overdue)).toBe(true);
    expect(Array.isArray(lists.goneQuiet)).toBe(true);
    expect(lists.overdue.every((row) => Number(row.amount) > 0)).toBe(true);
  });

  it('resolves every date range without a custom one being required', async () => {
    for (const range of ['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth'] as const) {
      const summary = await getDashboardSummary(ctx, owner, { range });
      expect(summary.range.from <= summary.range.to).toBe(true);
    }
  });
});
