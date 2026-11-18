/**
 * What the gym spends, and the receipt a member walks away with.
 *
 * The dashboard has shown an expenses figure since Phase 2 and it always
 * read zero, because nothing could record one — so "net" was revenue wearing
 * a different label. These are the tests that make that number mean
 * something.
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
  listExpenseCategories,
  recordExpense,
  listExpenses,
  expensesByCategory,
  deleteExpense,
  todaysExpenses,
  getReceiptDocument,
  getDashboardSummary,
  businessDayIso,
  AppError,
} from '@gym/core';
import { renderReceiptPdf } from '@gym/integrations';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let categories: Array<{ id: string; name: string }>;
let paymentId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  const email = `exp.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Expense Gym ${unique()}`,
    ownerName: 'Expense Owner',
    email,
    phone: '9876550000',
    password: 'correct horse battery staple 47',
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;

  categories = await listExpenseCategories(ctx, owner);

  // A real payment, so the receipt has something to describe.
  const plan = await createPlan(ctx, owner, {
    name: 'Monthly',
    durationUnit: 'MONTH',
    durationValue: 1,
    price: '1500.00',
  });
  const member = await createMember(ctx, owner, {
    firstName: 'Ravi',
    lastName: 'Kulkarni',
    phone: '9820440001',
  });
  const sale = await sellMembership(ctx, owner, {
    memberId: member.id,
    planId: plan.id,
    payment: { amount: '1500.00', method: 'UPI', referenceNumber: '432198765432' },
  });
  paymentId = sale.paymentId!;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  Categories
// =========================================================================

describe('expense categories', () => {
  it('gives a new gym a usable set rather than an empty list', () => {
    expect(categories.length).toBeGreaterThan(5);
    const names = categories.map((c) => c.name);
    // The ones an Indian gym pays every month.
    expect(names).toContain('Rent');
    expect(names).toContain('Salaries');
    expect(names).toContain('Electricity');
  });

  it('seeds them once, not on every read', async () => {
    const again = await listExpenseCategories(ctx, owner);
    expect(again.length).toBe(categories.length);
    expect(again[0]!.id).toBe(categories[0]!.id);
  });
});

// =========================================================================
//  Recording a spend
// =========================================================================

describe('recording an expense', () => {
  it('keeps the tax apart from the cost, because the bill does', async () => {
    const rent = categories.find((c) => c.name === 'Rent')!;

    const expense = await recordExpense(ctx, owner, {
      title: 'Shop rent — November',
      amount: '25000.00',
      taxAmount: '4500.00',
      expenseDate: '2026-11-05',
      categoryId: rent.id,
      method: 'BANK_TRANSFER',
      referenceNumber: 'NEFT-99182',
    });

    expect(expense.totalAmount).toBe('29500.00');

    const row = await db.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(row.amount.toString()).toBe('25000');
    expect(row.taxAmount.toString()).toBe('4500');
    expect(row.totalAmount.toString()).toBe('29500');
    // Input tax credit is claimed on the tax, so it cannot be folded in.
    expect(Number(row.amount) + Number(row.taxAmount)).toBe(Number(row.totalAmount));
  });

  it('works without a tax figure, because most small bills have none', async () => {
    const expense = await recordExpense(ctx, owner, {
      title: 'Cleaning supplies',
      amount: '1200.00',
      expenseDate: '2026-11-06',
      method: 'CASH',
    });
    expect(expense.totalAmount).toBe('1200.00');
  });

  it('refuses nothing and refuses negatives', async () => {
    await expect(
      recordExpense(ctx, owner, { title: 'Nothing', amount: '0', expenseDate: '2026-11-06' }),
    ).rejects.toThrow(AppError);

    await expect(
      recordExpense(ctx, owner, { title: 'Negative', amount: '-500', expenseDate: '2026-11-06' }),
    ).rejects.toThrow(AppError);
  });

  it('refuses a category belonging to nobody', async () => {
    await expect(
      recordExpense(ctx, owner, {
        title: 'Mystery',
        amount: '100',
        expenseDate: '2026-11-06',
        categoryId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(AppError);
  });

  it('writes an audit row, because money leaving needs a name against it', async () => {
    const audit = await db.auditLog.findFirst({
      where: { organizationId: gym.organizationId, action: 'expense.recorded' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.summary).toContain('Cleaning supplies');
    expect(audit?.actorUserId).toBe(gym.userId);
  });
});

// =========================================================================
//  Reading them back
// =========================================================================

describe('listing expenses', () => {
  it('totals the cost, the tax and the whole', async () => {
    const { rows, total, totals } = await listExpenses(ctx, owner, {});

    expect(total).toBe(2);
    expect(totals.amount).toBe('26200.00');
    expect(totals.tax).toBe('4500.00');
    expect(totals.grand).toBe('30700.00');

    // Newest first, and the categorised one carries its category name.
    expect(rows[0]!.title).toBe('Cleaning supplies');
    expect(rows[0]!.categoryName, 'uncategorised stays null rather than guessing').toBeNull();
    expect(rows[1]!.categoryName).toBe('Rent');
  });

  it('filters by date', async () => {
    const narrow = await listExpenses(ctx, owner, {
      fromDate: '2026-11-06',
      toDate: '2026-11-06',
    });
    expect(narrow.total).toBe(1);
    expect(narrow.rows[0]!.title).toBe('Cleaning supplies');
  });

  it('finds one by what it was for', async () => {
    const found = await listExpenses(ctx, owner, { search: 'rent' });
    expect(found.total).toBe(1);

    const byReference = await listExpenses(ctx, owner, { search: 'NEFT-99182' });
    expect(byReference.total).toBe(1);
  });

  it('says where the money went', async () => {
    const split = await expensesByCategory(ctx, owner, {});
    expect(split[0]!.label).toBe('Rent');
    expect(split[0]!.value).toBe(29500);
    // Largest first, because that is the one worth looking at.
    expect(split[0]!.value).toBeGreaterThan(split[1]?.value ?? 0);
  });

  it('counts an uncategorised spend rather than dropping it', async () => {
    const split = await expensesByCategory(ctx, owner, {});
    expect(split.some((row) => row.label === 'Uncategorised')).toBe(true);
  });
});

// =========================================================================
//  The dashboard's net figure
// =========================================================================

describe('the dashboard', () => {
  it('now has real expenses to subtract, so net means something', async () => {
    const today = businessDayIso();

    await recordExpense(ctx, owner, {
      title: 'Towel laundry',
      amount: '500.00',
      expenseDate: today,
      method: 'CASH',
    });

    const summary = await getDashboardSummary(ctx, owner, { range: 'today' });

    expect(Number(summary.money.expensesInRange)).toBe(500);
    expect(Number(summary.money.collectedInRange)).toBe(1500);
    expect(Number(summary.money.netInRange), 'collected minus spent').toBe(1000);
  });

  it('reports today’s spend on the gym’s own day', async () => {
    const today = await todaysExpenses(ctx, owner);
    expect(today.count).toBe(1);
    expect(today.total).toBe('500.00');
    expect(today.date).toBe(businessDayIso());
  });
});

// =========================================================================
//  Removing one
// =========================================================================

describe('removing an expense', () => {
  it('hides it but keeps it, with a reason in the audit log', async () => {
    const { rows } = await listExpenses(ctx, owner, { search: 'laundry' });
    const id = rows[0]!.id;

    await deleteExpense(ctx, owner, id, { reason: 'Entered twice' });

    const gone = await listExpenses(ctx, owner, { search: 'laundry' });
    expect(gone.total).toBe(0);

    // Still there, marked — a financial record does not get holes in it.
    const row = await db.expense.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();

    const audit = await db.auditLog.findFirst({
      where: { organizationId: gym.organizationId, action: 'expense.deleted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.summary).toContain('Entered twice');
  });

  it('stops counting towards the dashboard once removed', async () => {
    const summary = await getDashboardSummary(ctx, owner, { range: 'today' });
    expect(Number(summary.money.expensesInRange)).toBe(0);
  });
});

// =========================================================================
//  The receipt
// =========================================================================

describe('the payment receipt', () => {
  it('says who paid what, how, and what it was for', async () => {
    const receipt = await getReceiptDocument(ctx, owner, paymentId);

    expect(receipt.receipt.code).toMatch(/^RCP\/\d{4}-\d{2}\/\d{5}$/);
    expect(receipt.receipt.amount).toBe('1500.00');
    expect(receipt.receipt.amountInWords).toBe('One Thousand Five Hundred Rupees Only');
    expect(receipt.receipt.method).toBe('UPI');
    expect(receipt.receipt.referenceNumber).toBe('432198765432');

    expect(receipt.payer.name).toBe('Ravi Kulkarni');
    expect(receipt.payer.memberCode).toMatch(/^M\d{5}$/);

    // What the money was against — the question a member asks in March.
    expect(receipt.towards.planName).toBe('Monthly');
    expect(receipt.towards.invoiceCode).toMatch(/^INV\//);
    expect(receipt.towards.invoiceDue).toBe('0.00');

    // And who took it.
    expect(receipt.collectedBy).toBe('Expense Owner');
  });

  it('renders a real PDF', async () => {
    const document = await getReceiptDocument(ctx, owner, paymentId);
    const pdf = await renderReceiptPdf(document);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
    // The rupee sign needs the embedded font, like the invoice.
    expect(pdf.toString('latin1')).toContain('FontFile2');
  });

  it('is refused for another gym’s payment', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirs = await db.payment.findFirst({
      where: { organizationId: otherOrg.id },
      select: { id: true },
    });

    if (theirs) {
      await expect(getReceiptDocument(ctx, owner, theirs.id)).rejects.toThrow(AppError);
    }
  });
});
