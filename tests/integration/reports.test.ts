/**
 * Reports — the numbers somebody else asks for.
 *
 * The dashboard answers "how are we doing". This answers "what do I give
 * the accountant", which has a different tolerance for being approximately
 * right: a GST return is filed by rate, so a single figure for tax
 * collected cannot be filed at all.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  createPlan,
  sellMembership,
  recordPayment,
  createProduct,
  recordCounterSale,
  collectionsReport,
  taxReport,
  outstandingDues,
  membershipReport,
  toCsv,
  AppError,
} from '@gym/core';
import { nextTestAddress } from '../support/addresses';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let planId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  const email = `reports.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Reports Gym ${unique()}`,
    ownerName: 'Reports Owner',
    email,
    phone: '9876650000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
    ipAddress: nextTestAddress(),
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  const plan = await createPlan(ctx, owner, {
    name: 'Monthly',
    durationUnit: 'MONTH',
    durationValue: 1,
    price: '1500.00',
  });
  planId = plan.id;

  // Two paid memberships, one partly paid, and a counter sale.
  for (const [first, phone, paid] of [
    ['Paid', '9821000001', '1500.00'],
    ['AlsoPaid', '9821000002', '1500.00'],
    ['Owing', '9821000003', '500.00'],
  ] as const) {
    const member = await createMember(ctx, owner, {
      firstName: first,
      lastName: 'Member',
      phone,
    });
    await sellMembership(ctx, owner, {
      memberId: member.id,
      planId,
      payment: { amount: paid, method: first === 'AlsoPaid' ? 'UPI' : 'CASH' },
    });
  }

  const product = await createProduct(ctx, owner, {
    name: `Shaker ${unique()}`,
    sellingPrice: '300.00',
    openingStock: '10',
  });
  await recordCounterSale(ctx, owner, {
    lines: [{ productId: product.id, quantity: '1' }],
    customerName: 'Walk-in',
    payment: { amount: '300.00', method: 'CARD' },
  });
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================

describe('collections', () => {
  it('totals what came in, and splits it the way a drawer is counted', async () => {
    const report = await collectionsReport(ctx, owner, { from: iso(0), to: iso(0) });

    expect(Number(report.total)).toBeCloseTo(3800, 2);
    expect(report.count).toBe(4);

    const cash = report.byMethod.find((m) => m.method === 'CASH')!;
    expect(Number(cash.amount)).toBeCloseTo(2000, 2);
    const card = report.byMethod.find((m) => m.method === 'CARD')!;
    expect(Number(card.amount)).toBeCloseTo(300, 2);
  });

  it('says who took the money, which is how a shortfall is traced', async () => {
    const report = await collectionsReport(ctx, owner, { from: iso(0), to: iso(0) });
    const byOwner = report.byStaff.find((s) => s.name === 'Reports Owner')!;
    expect(byOwner).toBeDefined();
    expect(Number(byOwner.amount)).toBeCloseTo(3800, 2);
  });

  it('includes the last day of the range', async () => {
    const report = await collectionsReport(ctx, owner, { from: iso(-2), to: iso(0) });
    expect(Number(report.total)).toBeCloseTo(3800, 2);
    expect(report.byDay.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      collectionsReport(ctx, owner, { from: iso(0), to: iso(-5) }),
    ).rejects.toThrow(AppError);
  });
});

describe('the GST summary', () => {
  it('is built by rate, because that is how a return is filed', async () => {
    const report = await taxReport(ctx, owner, { from: iso(0), to: iso(0) });

    expect(Number(report.total)).toBeGreaterThan(0);
    expect(report.byRate.length).toBeGreaterThanOrEqual(1);

    const rate = report.byRate[0]!;
    expect(Number(rate.ratePercent)).toBeGreaterThan(0);
    expect(Number(rate.taxable) + Number(rate.tax)).toBeCloseTo(Number(rate.total), 2);
    expect(rate.invoices).toBeGreaterThanOrEqual(1);
  });

  it('splits CGST and SGST from the rate’s own components, not by halving', async () => {
    const report = await taxReport(ctx, owner, { from: iso(0), to: iso(0) });
    const rate = report.byRate.find((r) => Number(r.tax) > 0)!;

    // The seeded Indian rates carry a cgst/sgst split, so both must be set
    // and together make the tax.
    expect(Number(rate.cgst)).toBeGreaterThan(0);
    expect(Number(rate.sgst)).toBeGreaterThan(0);
    expect(Number(rate.cgst) + Number(rate.sgst) + Number(rate.igst)).toBeCloseTo(
      Number(rate.tax),
      1,
    );
  });

  it('separates what was sold: memberships from the shop', async () => {
    const report = await taxReport(ctx, owner, { from: iso(0), to: iso(0) });
    const types = report.byItemType.map((r) => r.itemType);
    expect(types).toContain('MEMBERSHIP');
    expect(types).toContain('PRODUCT');

    const product = report.byItemType.find((r) => r.itemType === 'PRODUCT')!;
    expect(Number(product.total)).toBeCloseTo(300, 2);
  });

  it('adds up to the same total as the parts', async () => {
    const report = await taxReport(ctx, owner, { from: iso(0), to: iso(0) });
    const summed = report.byRate.reduce((sum, r) => sum + Number(r.total), 0);
    expect(summed).toBeCloseTo(Number(report.total), 2);
    expect(Number(report.taxable) + Number(report.tax)).toBeCloseTo(Number(report.total), 2);
  });
});

describe('what is owed', () => {
  it('groups by member, because a gym rings a person rather than a document', async () => {
    const dues = await outstandingDues(ctx, owner, {});

    expect(Number(dues.total)).toBeCloseTo(1000, 2);
    const owing = dues.rows.find((r) => r.name.startsWith('Owing'))!;
    expect(owing).toBeDefined();
    expect(Number(owing.amountDue)).toBeCloseTo(1000, 2);
    expect(owing.invoices).toBe(1);
    expect(owing.phone).toBe('9821000003');
  });

  it('counts a second unpaid invoice into the same conversation', async () => {
    const member = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9821000003' },
      select: { id: true },
    });

    await sellMembership(ctx, owner, { memberId: member.id, planId });

    const dues = await outstandingDues(ctx, owner, {});
    const owing = dues.rows.find((r) => r.memberId === member.id)!;
    expect(owing.invoices).toBe(2);
    expect(Number(owing.amountDue)).toBeCloseTo(2500, 2);
  });

  it('leaves a fully paid member out of it', async () => {
    const dues = await outstandingDues(ctx, owner, {});
    expect(dues.rows.some((r) => r.name.startsWith('Paid'))).toBe(false);
  });
});

describe('memberships', () => {
  it('tells a renewal from a first sale', async () => {
    const report = await membershipReport(ctx, owner, { from: iso(0), to: iso(0) });

    // Four sold: three first-time, and the second one to the owing member is
    // a renewal because it followed their existing subscription.
    expect(report.sold).toBe(4);
    expect(report.renewals).toBe(1);
    expect(report.firstTime).toBe(3);
    expect(Number(report.revenue)).toBeCloseTo(6000, 2);
  });

  it('breaks the revenue down by plan', async () => {
    const report = await membershipReport(ctx, owner, { from: iso(0), to: iso(0) });
    expect(report.byPlan[0]!.planName).toBe('Monthly');
    expect(report.byPlan[0]!.sold).toBe(4);
  });

  it('does not report 100% renewal when nothing came up for renewal', async () => {
    const report = await membershipReport(ctx, owner, { from: iso(-40), to: iso(-30) });
    // Zero expiries is nothing to measure, not perfect retention.
    expect(report.sold).toBe(0);
    expect(report.renewalRate).toBe(0);
  });
});

describe('the CSV', () => {
  it('quotes everything, so a comma in a name cannot break the file', () => {
    const csv = toCsv([{ name: 'Gold’s, Nagar', amount: '1,500.00' }]);
    expect(csv).toBe('"name","amount"\r\n"Gold’s, Nagar","1,500.00"');
  });

  it('escapes a quote by doubling it', () => {
    const csv = toCsv([{ note: 'He said "yes"' }]);
    expect(csv).toContain('"He said ""yes"""');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    // =HYPERLINK(...) in an exported name is a real attack on whoever opens
    // the file, not a theoretical one.
    const csv = toCsv([{ name: '=HYPERLINK("http://evil","click")' }]);
    expect(csv).toContain(`"'=HYPERLINK`);
  });

  it('is empty for no rows rather than a stray header', () => {
    expect(toCsv([])).toBe('');
  });
});

describe('one gym’s figures are not another’s', () => {
  it('reports nothing of another gym’s money', async () => {
    const email = `reports.other.${unique()}@example.com`;
    createdEmails.push(email);

    const other = await registerGym({
      gymName: `Other Reports ${unique()}`,
      ownerName: 'Other Owner',
      email,
      phone: '9876660000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    ipAddress: nextTestAddress(),
    });
    createdOrgIds.push(other.organizationId);

    const otherCtx = { organizationId: other.organizationId, userId: other.userId };
    const otherSession = await createSession(authPrisma, {
      userId: other.userId,
      organizationId: other.organizationId,
      type: 'WEB',
    });
    const otherOwner = (await resolveSession(authPrisma, otherSession.token)).actor.permissions;

    const collections = await collectionsReport(otherCtx, otherOwner, {
      from: iso(-30),
      to: iso(0),
    });
    expect(collections.total).toBe('0.00');
    expect(collections.count).toBe(0);

    const tax = await taxReport(otherCtx, otherOwner, { from: iso(-30), to: iso(0) });
    expect(tax.total).toBe('0.00');

    const dues = await outstandingDues(otherCtx, otherOwner, {});
    expect(dues.rows).toHaveLength(0);

    const memberships = await membershipReport(otherCtx, otherOwner, {
      from: iso(-30),
      to: iso(0),
    });
    expect(memberships.sold).toBe(0);
  });
});
