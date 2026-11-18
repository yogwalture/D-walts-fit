/**
 * The shop behind the front desk.
 *
 * Two things matter here and neither is the product list. Stock has to be a
 * ledger that explains itself, and a counter sale has to be a real taxable
 * supply — a protein shake sold at the desk is as much a GST invoice as a
 * membership, and an accountant should not have to reconcile two parallel
 * notions of a sale.
 *
 * The last protein bar is the same race as the last place in a class, so it
 * is tested the same way: concurrent sales of a single unit.
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
  listProducts,
  createProduct,
  updateProduct,
  recordMovement,
  listMovements,
  recordCounterSale,
  shopSummary,
  listInvoices,
  dailyCollection,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];
let memberId: string;

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  const email = `shop.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Shop Gym ${unique()}`,
    ownerName: 'Shop Owner',
    email,
    phone: '9876610000',
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

  const member = await createMember(ctx, owner, {
    firstName: 'Shopper',
    lastName: 'Member',
    phone: '9820010001',
  });
  memberId = member.id;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  What the gym sells
// =========================================================================

describe('products', () => {
  it('takes the gym’s default GST rate when none is named', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Whey 1kg ${unique()}`,
      sellingPrice: '2400.00',
      purchasePrice: '1800.00',
      openingStock: '10',
      reorderLevel: '3',
    });

    const rows = await listProducts(ctx, owner);
    const whey = rows.find((p) => p.id === product.id)!;
    // Silently charging 0% is an under-collection nobody notices until the
    // return is filed.
    expect(whey.taxRateId).not.toBeNull();
    expect(Number(whey.taxPercentage)).toBeGreaterThan(0);
    expect(whey.quantityOnHand).toBe('10');
  });

  it('records opening stock as a movement, so the shelf figure is explainable', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Shaker ${unique()}`,
      sellingPrice: '350.00',
      openingStock: '24',
    });

    const movements = await listMovements(ctx, owner, { productId: product.id });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.movementType).toBe('PURCHASE');
    expect(movements[0]!.balanceAfter).toBe('24');
  });

  it('refuses two products sharing a code', async () => {
    const sku = `SKU-${unique()}`;
    await createProduct(ctx, owner, { name: `First ${unique()}`, sellingPrice: '100', sku });
    await expect(
      createProduct(ctx, owner, { name: `Second ${unique()}`, sellingPrice: '100', sku }),
    ).rejects.toThrow(/already uses the code/i);
  });

  it('flags what is at or below its reorder level', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Bars ${unique()}`,
      sellingPrice: '120.00',
      openingStock: '5',
      reorderLevel: '5',
    });

    const low = await listProducts(ctx, owner, { lowOnly: true });
    // At the level, not below it: a gym that waits for zero has already
    // turned somebody away.
    expect(low.map((p) => p.id)).toContain(product.id);
  });
});

// =========================================================================
//  Stock as a ledger
// =========================================================================

describe('stock', () => {
  it('adds a delivery and carries the balance after it', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Creatine ${unique()}`,
      sellingPrice: '900.00',
      openingStock: '2',
    });

    const result = await recordMovement(ctx, owner, {
      productId: product.id,
      movementType: 'PURCHASE',
      quantity: '12',
      unitPrice: '650.00',
    });

    expect(result.balanceAfter).toBe('14');
    const movements = await listMovements(ctx, owner, { productId: product.id });
    expect(movements[0]!.balanceAfter).toBe('14');
    expect(movements[0]!.recordedBy).toBe('Shop Owner');
  });

  it('will not let stock go negative', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Towels ${unique()}`,
      sellingPrice: '200.00',
      openingStock: '3',
    });

    await expect(
      recordMovement(ctx, owner, {
        productId: product.id,
        movementType: 'ADJUSTMENT',
        quantity: '-5',
        notes: 'Miscount',
      }),
    ).rejects.toThrow(/only 3/i);
  });

  it('insists on a reason for wastage, because the audit trail cannot tell it from theft', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Drinks ${unique()}`,
      sellingPrice: '60.00',
      openingStock: '10',
    });

    await expect(
      recordMovement(ctx, owner, {
        productId: product.id,
        movementType: 'WASTAGE',
        quantity: '-2',
      }),
    ).rejects.toThrow(AppError);

    const written = await recordMovement(ctx, owner, {
      productId: product.id,
      movementType: 'WASTAGE',
      quantity: '-2',
      notes: 'Past the expiry date',
    });
    expect(written.balanceAfter).toBe('8');
  });

  it('takes a correction as a signed difference, never as a new total', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Gloves ${unique()}`,
      sellingPrice: '450.00',
      openingStock: '6',
    });

    await recordMovement(ctx, owner, {
      productId: product.id,
      movementType: 'ADJUSTMENT',
      quantity: '-1',
      notes: 'One missing at the stock count',
    });

    const rows = await listProducts(ctx, owner);
    expect(rows.find((p) => p.id === product.id)!.quantityOnHand).toBe('5');

    // And editing a product cannot touch the figure at all.
    await updateProduct(ctx, owner, product.id, { sellingPrice: '500.00' });
    const after = await listProducts(ctx, owner);
    expect(after.find((p) => p.id === product.id)!.quantityOnHand).toBe('5');
    expect(after.find((p) => p.id === product.id)!.sellingPrice).toBe('500.00');
  });

  it('refuses a correction of nothing', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Socks ${unique()}`,
      sellingPrice: '150.00',
      openingStock: '4',
    });
    await expect(
      recordMovement(ctx, owner, {
        productId: product.id,
        movementType: 'ADJUSTMENT',
        quantity: '0',
        notes: 'Nothing',
      }),
    ).rejects.toThrow(AppError);
  });
});

// =========================================================================
//  The counter
// =========================================================================

describe('a sale at the counter', () => {
  it('raises a real GST invoice and takes the stock down', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Protein bar ${unique()}`,
      sellingPrice: '100.00',
      purchasePrice: '60.00',
      openingStock: '20',
    });

    const sale = await recordCounterSale(ctx, owner, {
      lines: [{ productId: product.id, quantity: '2' }],
      memberId,
      payment: { amount: '200.00', method: 'CASH' },
    });

    expect(sale.total).toBe('200.00');
    // The shelf price includes tax in India, so the rate comes out of the
    // marked price rather than being added on top of it.
    expect(Number(sale.tax)).toBeGreaterThan(0);
    expect(Number(sale.total)).toBe(200);
    expect(sale.due).toBe('0.00');
    expect(sale.receiptCode).not.toBeNull();
    expect(sale.lines[0]!.stockLeft).toBe('18');

    // One set of documents, not two: it is in the invoice list like any other.
    const { rows } = await listInvoices(ctx, owner, { page: 1, pageSize: 25 });
    expect(rows.some((r) => r.invoiceCode === sale.invoiceCode)).toBe(true);

    const lines = await db.invoiceLine.findMany({ where: { invoiceId: sale.invoiceId } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.itemType).toBe('PRODUCT');
    expect(lines[0]!.productId).toBe(product.id);
  });

  it('puts the money in the same till as a membership', async () => {
    const before = await dailyCollection(ctx, owner, {});

    const product = await createProduct(ctx, owner, {
      name: `Energy drink ${unique()}`,
      sellingPrice: '80.00',
      openingStock: '10',
    });
    await recordCounterSale(ctx, owner, {
      lines: [{ productId: product.id, quantity: '1' }],
      memberId,
      payment: { amount: '80.00', method: 'UPI' },
    });

    const after = await dailyCollection(ctx, owner, {});
    // "Collected today" has to be the whole till, or the cash count will not
    // agree with the screen.
    expect(Number(after.total) - Number(before.total)).toBeCloseTo(80, 2);
  });

  it('records the movement against the invoice that caused it', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Band ${unique()}`,
      sellingPrice: '250.00',
      openingStock: '5',
    });

    const sale = await recordCounterSale(ctx, owner, {
      lines: [{ productId: product.id, quantity: '1' }],
      customerName: 'Walk-in',
      payment: { amount: '250.00', method: 'CASH' },
    });

    const movement = await db.stockMovement.findFirstOrThrow({
      where: { productId: product.id, movementType: 'SALE' },
    });
    expect(movement.referenceType).toBe('Invoice');
    expect(movement.referenceId).toBe(sale.invoiceId);
    expect(Number(movement.quantity)).toBe(-1);
    expect(Number(movement.balanceAfter)).toBe(4);
  });

  it('refuses to sell what is not on the shelf', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Last one ${unique()}`,
      sellingPrice: '300.00',
      openingStock: '1',
    });

    await expect(
      recordCounterSale(ctx, owner, {
        lines: [{ productId: product.id, quantity: '2' }],
        payment: { amount: '600.00', method: 'CASH' },
      }),
    ).rejects.toThrow(/only 1/i);
  });

  it('never sells the last one twice, even to simultaneous counters', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Single ${unique()}`,
      sellingPrice: '500.00',
      openingStock: '1',
    });

    const attempts = await Promise.allSettled([
      recordCounterSale(ctx, owner, {
        lines: [{ productId: product.id, quantity: '1' }],
        payment: { amount: '500.00', method: 'CASH' },
      }),
      recordCounterSale(ctx, owner, {
        lines: [{ productId: product.id, quantity: '1' }],
        payment: { amount: '500.00', method: 'CASH' },
      }),
    ]);

    const sold = attempts.filter((a) => a.status === 'fulfilled');
    const refused = attempts.filter((a) => a.status === 'rejected');
    expect(sold).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const row = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(row.quantityOnHand)).toBe(0);
  });

  it('will not let a walk-in leave owing money', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Cap ${unique()}`,
      sellingPrice: '400.00',
      openingStock: '3',
    });

    // There is no account to chase it on.
    await expect(
      recordCounterSale(ctx, owner, {
        lines: [{ productId: product.id, quantity: '1' }],
        customerName: 'Stranger',
        payment: { amount: '100.00', method: 'CASH' },
      }),
    ).rejects.toThrow(/paid in full/i);

    // A member may, because the gym can.
    const onAccount = await recordCounterSale(ctx, owner, {
      lines: [{ productId: product.id, quantity: '1' }],
      memberId,
      payment: { amount: '100.00', method: 'CASH' },
    });
    expect(onAccount.due).toBe('300.00');
  });

  it('refuses a payment larger than the sale', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Bottle ${unique()}`,
      sellingPrice: '200.00',
      openingStock: '5',
    });
    await expect(
      recordCounterSale(ctx, owner, {
        lines: [{ productId: product.id, quantity: '1' }],
        memberId,
        payment: { amount: '500.00', method: 'CASH' },
      }),
    ).rejects.toThrow(/more than the amount due/i);
  });

  it('will not sell something the gym has retired', async () => {
    const product = await createProduct(ctx, owner, {
      name: `Discontinued ${unique()}`,
      sellingPrice: '100.00',
      openingStock: '5',
    });
    await updateProduct(ctx, owner, product.id, { isActive: false });

    await expect(
      recordCounterSale(ctx, owner, {
        lines: [{ productId: product.id, quantity: '1' }],
        memberId,
        payment: { amount: '100.00', method: 'CASH' },
      }),
    ).rejects.toThrow(/no longer sold/i);
  });

  it('sells several things on one invoice', async () => {
    const one = await createProduct(ctx, owner, {
      name: `Combo A ${unique()}`,
      sellingPrice: '150.00',
      openingStock: '10',
    });
    const two = await createProduct(ctx, owner, {
      name: `Combo B ${unique()}`,
      sellingPrice: '250.00',
      openingStock: '10',
    });

    const sale = await recordCounterSale(ctx, owner, {
      lines: [
        { productId: one.id, quantity: '2' },
        { productId: two.id, quantity: '1' },
      ],
      memberId,
      payment: { amount: '550.00', method: 'CARD' },
    });

    expect(sale.total).toBe('550.00');
    expect(sale.lines).toHaveLength(2);
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: sale.invoiceId } });
    expect(lines).toHaveLength(2);
  });
});

// =========================================================================
//  What the owner asks
// =========================================================================

describe('the shop at a glance', () => {
  it('values the stock at cost and counts what is running out', async () => {
    const summary = await shopSummary(ctx, owner);
    expect(summary.productCount).toBeGreaterThan(0);
    expect(Number(summary.stockValue)).toBeGreaterThan(0);
    expect(summary.lowStockCount).toBeGreaterThanOrEqual(1);
    expect(Number(summary.soldToday)).toBeGreaterThan(0);
  });
});

// =========================================================================
//  Isolation
// =========================================================================

describe('one gym’s shop is not another’s', () => {
  it('cannot read, sell or adjust another gym’s stock', async () => {
    const email = `shop.other.${unique()}@example.com`;
    createdEmails.push(email);

    const other = await registerGym({
      gymName: `Other Shop ${unique()}`,
      ownerName: 'Other Owner',
      email,
      phone: '9876620000',
      password: 'correct horse battery staple 47',
      planKey: 'PROFESSIONAL',
      acceptedTerms: true,
    });
    createdOrgIds.push(other.organizationId);

    const otherCtx = { organizationId: other.organizationId, userId: other.userId };
    const otherSession = await createSession(authPrisma, {
      userId: other.userId,
      organizationId: other.organizationId,
      type: 'WEB',
    });
    const otherOwner = (await resolveSession(authPrisma, otherSession.token)).actor.permissions;

    const ours = await createProduct(ctx, owner, {
      name: `Private stock ${unique()}`,
      sellingPrice: '999.00',
      openingStock: '10',
    });

    const theirs = await listProducts(otherCtx, otherOwner);
    expect(theirs.find((p) => p.id === ours.id)).toBeUndefined();

    await expect(
      recordMovement(otherCtx, otherOwner, {
        productId: ours.id,
        movementType: 'ADJUSTMENT',
        quantity: '-5',
        notes: 'Mischief',
      }),
    ).rejects.toThrow(/not found/i);

    await expect(
      recordCounterSale(otherCtx, otherOwner, {
        lines: [{ productId: ours.id, quantity: '1' }],
        payment: { amount: '999.00', method: 'CASH' },
      }),
    ).rejects.toThrow(/not found/i);

    const movements = await listMovements(otherCtx, otherOwner, { productId: ours.id });
    expect(movements).toHaveLength(0);

    // Untouched.
    const still = await listProducts(ctx, owner);
    expect(still.find((p) => p.id === ours.id)!.quantityOnHand).toBe('10');
  });
});
