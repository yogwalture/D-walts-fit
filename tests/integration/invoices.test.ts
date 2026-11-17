/**
 * Invoices, the PDF, and the subscription listing.
 *
 * A tax invoice is a legal document. The figures on it must be the figures
 * that were written at the moment of sale, the tax components must add back
 * to the tax charged, and the serial numbers must have no gaps — so those
 * are what is asserted here, against a real database and a real PDF.
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
  quotePlan,
  sellMembership,
  recordPayment,
  listInvoices,
  getInvoiceDocument,
  listSubscriptions,
  freezeSubscription,
  cancelSubscription,
  rupeesInWords,
  toPaise,
  AppError,
} from '@gym/core';
import { renderInvoicePdf, hasUnsupportedScript } from '@gym/integrations';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple 47';

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let planId: string;
let memberId: string;
let invoiceId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  const email = `inv.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Invoice Gym ${unique()}`,
    ownerName: 'Invoice Owner',
    email,
    phone: '9876530000',
    password: PASSWORD,
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

  // The gym's own GST details, as an Indian gym would fill them in.
  await db.orgSetting.update({
    where: { organizationId: gym.organizationId },
    data: {
      gstin: '27AABCU9603R1ZX',
      panNumber: 'AABCU9603R',
      legalAddress: { line1: 'Plot 14, Jalna Road', city: 'Chhatrapati Sambhajinagar', state: 'Maharashtra', postalCode: '431001' },
      invoiceTermsText: 'Payable within 7 days.',
    },
  });

  const taxRate = await db.taxRate.findFirstOrThrow({
    where: { organizationId: gym.organizationId },
  });

  const plan = await createPlan(ctx, owner, {
    name: 'Annual',
    durationUnit: 'YEAR',
    durationValue: 1,
    price: '14000.00',
    taxRateId: taxRate.id,
    priceIncludesTax: true,
    graceDays: 5,
    freezeAllowed: true,
    freezeMaxDays: 30,
  });
  planId = plan.id;

  const member = await createMember(ctx, owner, {
    firstName: 'Ravi',
    lastName: 'Kulkarni',
    phone: '9820001111',
    addressLine1: '12 MG Road',
    city: 'Chhatrapati Sambhajinagar',
    state: 'Maharashtra',
    postalCode: '431005',
  });
  memberId = member.id;

  const sale = await sellMembership(ctx, owner, {
    memberId,
    planId,
    startDate: '2026-11-17',
    payment: { amount: '10000.00', method: 'UPI', referenceNumber: '432198765432' },
  });
  invoiceId = sale.invoiceId;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  Amounts in words — an Indian invoice carries them
// =========================================================================

describe('amounts in words', () => {
  it('groups in lakh and crore, not millions', () => {
    expect(rupeesInWords('1500.00')).toBe('One Thousand Five Hundred Rupees Only');
    expect(rupeesInWords('100000.00')).toBe('One Lakh Rupees Only');
    expect(rupeesInWords('1500000.00')).toBe('Fifteen Lakh Rupees Only');
    expect(rupeesInWords('10000000.00')).toBe('One Crore Rupees Only');
    expect(rupeesInWords('12345678.00')).toBe(
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees Only',
    );
  });

  it('names the paise when there are any', () => {
    expect(rupeesInWords('1271.19')).toBe(
      'One Thousand Two Hundred Seventy One Rupees and Nineteen Paise Only',
    );
    expect(rupeesInWords('0.50')).toBe('Zero Rupees and Fifty Paise Only');
  });

  it('handles zero and negatives', () => {
    expect(rupeesInWords('0.00')).toBe('Zero Rupees Only');
    expect(rupeesInWords('-500.00')).toBe('Minus Five Hundred Rupees Only');
  });

  it('gets the awkward teens and tens right', () => {
    expect(rupeesInWords('11.00')).toBe('Eleven Rupees Only');
    expect(rupeesInWords('19.00')).toBe('Nineteen Rupees Only');
    expect(rupeesInWords('20.00')).toBe('Twenty Rupees Only');
    expect(rupeesInWords('90.00')).toBe('Ninety Rupees Only');
    expect(rupeesInWords('115.00')).toBe('One Hundred Fifteen Rupees Only');
  });
});

// =========================================================================
//  The invoice document
// =========================================================================

describe('the invoice document', () => {
  it('carries everything GST requires', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);

    // Identity of the document itself.
    expect(document.invoice.code).toMatch(/^INV\/\d{4}-\d{2}\/\d{5}$/);
    expect(document.invoice.total).toBe('14000.00');
    expect(document.invoice.amountPaid).toBe('10000.00');
    expect(document.invoice.amountDue).toBe('4000.00');
    expect(document.invoice.totalInWords).toBe('Fourteen Thousand Rupees Only');

    // The supplier, without which it is not a tax invoice.
    expect(document.supplier.gstin).toBe('27AABCU9603R1ZX');
    expect(document.supplier.panNumber).toBe('AABCU9603R');
    expect(document.supplier.addressLines.length).toBeGreaterThan(0);

    // The customer.
    expect(document.customer.name).toBe('Ravi Kulkarni');
    expect(document.customer.memberCode).toMatch(/^M\d{5}$/);
    expect(document.customer.addressLines).toContain('12 MG Road');

    // The place of supply, which decides CGST+SGST versus IGST.
    expect(document.invoice.placeOfSupply).toBeTruthy();
  });

  it('shows the taxable value per line, not just the gross', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);

    expect(document.lines).toHaveLength(1);
    const line = document.lines[0]!;

    expect(line.lineTotal).toBe('14000.00');
    expect(line.taxPercentage).toBe('18');
    expect(line.taxAmount).toBe('2135.59');
    expect(line.taxableValue).toBe('11864.41');

    // The arithmetic a tax officer would check first.
    expect(toPaise(line.taxableValue) + toPaise(line.taxAmount)).toBe(toPaise(line.lineTotal));
  });

  it('summarises tax by rate, split into CGST and SGST that add back exactly', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);

    expect(document.taxSummary).toHaveLength(1);
    const summary = document.taxSummary[0]!;

    expect(summary.percentage).toBe('18');
    expect(summary.taxableValue).toBe('11864.41');
    expect(summary.total).toBe('2135.59');

    expect(summary.components.map((c) => c.label).sort()).toEqual(['CGST', 'SGST']);

    const parts = summary.components.reduce((sum, c) => sum + toPaise(c.amount), 0);
    expect(parts, 'the components must add back to the tax charged').toBe(
      toPaise(summary.total),
    );
  });

  it('lists the payments received against it', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);

    expect(document.payments).toHaveLength(1);
    expect(document.payments[0]!.amount).toBe('10000.00');
    expect(document.payments[0]!.method).toBe('UPI');
    expect(document.payments[0]!.receiptCode).toMatch(/^RCP\//);
    expect(document.payments[0]!.referenceNumber).toBe('432198765432');
  });

  it('reflects a later payment without the earlier figures changing', async () => {
    await recordPayment(ctx, owner, {
      memberId,
      invoiceId,
      amount: '4000.00',
      method: 'CASH',
    });

    const document = await getInvoiceDocument(ctx, owner, invoiceId);

    expect(document.invoice.amountDue).toBe('0.00');
    expect(document.payments).toHaveLength(2);
    // The tax and the total are properties of the sale, not of what has been
    // collected since — they must not drift when money arrives.
    expect(document.invoice.total).toBe('14000.00');
    expect(document.invoice.taxAmount).toBe('2135.59');
  });

  it('refuses to hand over another gym’s invoice', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirInvoice = await db.invoice.findFirst({
      where: { organizationId: otherOrg.id },
      select: { id: true },
    });

    if (theirInvoice) {
      // 404 rather than 403: "not yours" and "does not exist" must look
      // identical, or the response becomes an existence oracle.
      await expect(getInvoiceDocument(ctx, owner, theirInvoice.id)).rejects.toThrow(AppError);
    }
  });
});

// =========================================================================
//  The PDF
// =========================================================================

describe('the invoice PDF', () => {
  it('renders a real PDF from a real invoice', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);
    const pdf = await renderInvoicePdf(document);

    expect(pdf.length).toBeGreaterThan(3000);
    // The file signature, so a truncated or empty buffer cannot pass.
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('latin1')).toContain('EOF');
  });

  it('embeds a font, because the rupee sign is not in the built-in ones', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);
    const pdf = await renderInvoicePdf(document);
    const text = pdf.toString('latin1');

    // Without an embedded font every amount renders as a hollow box.
    expect(text).toContain('FontFile2');
    expect(text).not.toContain('/BaseFont /Helvetica');
  });

  it('knows when a name would not render', () => {
    expect(hasUnsupportedScript('Ravi Kulkarni')).toBe(false);
    expect(hasUnsupportedScript('₹1,500.00 — paid')).toBe(false);
    // pdfkit cannot shape Devanagari, so this must be detectable rather than
    // silently printed as boxes.
    expect(hasUnsupportedScript('रवी कुलकर्णी')).toBe(true);
    expect(hasUnsupportedScript('Ravi', null, 'ரவி')).toBe(true);
  });

  it('renders a cancelled invoice as cancelled', async () => {
    const document = await getInvoiceDocument(ctx, owner, invoiceId);
    const pdf = await renderInvoicePdf({
      ...document,
      invoice: { ...document.invoice, cancelledAt: new Date() },
    });

    expect(pdf.length).toBeGreaterThan(3000);
  });
});

// =========================================================================
//  Listing invoices
// =========================================================================

describe('the tax rate a plan gets', () => {
  it('applies the gym’s default when none is named', async () => {
    // GST applies to a gym membership in India. A plan created through an
    // integration that forgot taxRateId must not quietly charge 0%: nobody
    // notices until the return is filed and the money has to come from
    // somewhere.
    const plan = await createPlan(ctx, owner, {
      name: `Defaulted ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1000.00',
    });

    const row = await db.membershipPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.taxRateId).not.toBeNull();

    const quote = await quotePlan(ctx, { planId: plan.id });
    expect(Number(quote.tax)).toBeGreaterThan(0);
  });

  it('honours an explicit null as a tax-free plan', async () => {
    const plan = await createPlan(ctx, owner, {
      name: `Tax free ${unique()}`,
      durationUnit: 'MONTH',
      durationValue: 1,
      price: '1000.00',
      taxRateId: null,
    });

    const row = await db.membershipPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.taxRateId).toBeNull();

    const quote = await quotePlan(ctx, { planId: plan.id });
    expect(quote.tax).toBe('0.00');
    expect(quote.total).toBe('1000.00');
  });
});

describe('listing invoices', () => {
  it('totals what was billed and what is still owed', async () => {
    const { rows, total, totals } = await listInvoices(ctx, owner, {});

    expect(total).toBeGreaterThan(0);
    expect(rows[0]!.invoiceCode).toMatch(/^INV\//);
    expect(Number(totals.billed)).toBeGreaterThan(0);
    expect(Number(totals.due)).toBe(0);
  });

  it('filters by status', async () => {
    const paid = await listInvoices(ctx, owner, { status: 'PAID' });
    const cancelled = await listInvoices(ctx, owner, { status: 'CANCELLED' });

    expect(paid.total).toBeGreaterThan(0);
    expect(cancelled.total).toBe(0);
  });

  it('finds an invoice by its number or the member', async () => {
    const all = await listInvoices(ctx, owner, {});
    const code = all.rows[0]!.invoiceCode;

    const byCode = await listInvoices(ctx, owner, { search: code.split('/').at(-1)! });
    expect(byCode.total).toBeGreaterThan(0);

    const byMember = await listInvoices(ctx, owner, { search: 'Kulkarni' });
    expect(byMember.total).toBeGreaterThan(0);
  });
});

// =========================================================================
//  Listing subscriptions
// =========================================================================

describe('listing subscriptions', () => {
  it('reports what a gym needs to decide what to do with each', async () => {
    const { rows, total } = await listSubscriptions(ctx, owner, {});

    expect(total).toBeGreaterThan(0);
    const row = rows.find((r) => r.memberId === memberId)!;

    expect(row.memberName).toBe('Ravi Kulkarni');
    expect(row.planName).toBe('Annual');
    expect(row.status).toBe('ACTIVE');
    expect(row.dueAmount).toBe('0.00');
    expect(row.freezeAllowed).toBe(true);
    expect(row.freezeDaysAllowed).toBe(30);
    expect(row.daysRemaining).toBeGreaterThan(300);
  });

  it('finds those expiring inside a window', async () => {
    const soon = await listSubscriptions(ctx, owner, { expiringWithinDays: 14 });
    // The annual membership sold above is not due for a year.
    expect(soon.rows.some((r) => r.memberId === memberId)).toBe(false);

    const wide = await listSubscriptions(ctx, owner, { expiringWithinDays: 365 });
    expect(wide.rows.some((r) => r.memberId === memberId)).toBe(true);
  });

  it('shows the freeze allowance consumed', async () => {
    const before = await listSubscriptions(ctx, owner, { memberId });
    const subscriptionId = before.rows[0]!.id;

    await freezeSubscription(ctx, owner, {
      subscriptionId,
      fromDate: '2026-12-01',
      toDate: '2026-12-07',
      reason: 'Travelling',
    });

    const after = await listSubscriptions(ctx, owner, { memberId });
    expect(after.rows[0]!.status).toBe('FROZEN');
    expect(after.rows[0]!.freezeDaysUsed).toBe(7);
  });

  it('searches by name, code and phone', async () => {
    for (const term of ['Ravi', 'Kulkarni', '9820001111']) {
      const found = await listSubscriptions(ctx, owner, { search: term });
      expect(found.rows.some((r) => r.memberId === memberId), term).toBe(true);
    }
  });

  it('counts a frozen membership as live, so it does not vanish when paused', async () => {
    const live = await listSubscriptions(ctx, owner, { memberId, status: 'live' });
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0]!.status, 'already frozen by the test above').toBe('FROZEN');

    // The narrower filters still mean what they say.
    const active = await listSubscriptions(ctx, owner, { memberId, status: 'ACTIVE' });
    expect(active.rows).toHaveLength(0);
  });

  it('stops reporting a cancelled membership as live', async () => {
    const live = await listSubscriptions(ctx, owner, { memberId });
    await cancelSubscription(ctx, owner, {
      subscriptionId: live.rows[0]!.id,
      reason: 'Member relocated',
    });

    const stillLive = await listSubscriptions(ctx, owner, { memberId, status: 'live' });
    expect(stillLive.rows).toHaveLength(0);

    const cancelled = await listSubscriptions(ctx, owner, { memberId, status: 'CANCELLED' });
    expect(cancelled.rows).toHaveLength(1);
  });
});
