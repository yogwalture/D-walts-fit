import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import {
  requirePermission,
  type ResolvedPermissions,
} from '../rbac/engine';
import { allocateInvoiceNumber, allocateReceiptNumber } from '../shared/sequences';
import { splitTax, toPaise, toRupees } from '../shared/money';
import { businessDayRange, today } from '../shared/dates';

/**
 * Products, stock and the counter.
 *
 * The shelf behind the desk is a real shop: a protein shake sold there is a
 * taxable supply in India, so a counter sale raises a proper GST invoice
 * through the same machinery a membership does, rather than a separate
 * parallel notion of a receipt that the accountant then cannot reconcile.
 *
 * Stock is a ledger, not a number. `quantityOnHand` is the running total,
 * but every change writes a movement carrying the balance after it, so the
 * figure can always be explained — and when it disagrees with the shelf, a
 * correction is a recorded adjustment with a reason rather than someone
 * typing over the total.
 *
 * Two people selling the last protein bar at the same moment is the same
 * race as two members booking the last place in a class, and it is handled
 * the same way: the product row is locked for the duration of the sale.
 */

export interface InventoryContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export type MovementType = 'PURCHASE' | 'SALE' | 'ADJUSTMENT' | 'WASTAGE' | 'RETURN' | 'TRANSFER';

// -------------------------------------------------------------- products ---

export interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  sku: string | null;
  unit: string;
  purchasePrice: string;
  sellingPrice: string;
  quantityOnHand: string;
  reorderLevel: string;
  needsReorder: boolean;
  isActive: boolean;
  taxRateId: string | null;
  taxPercentage: string | null;
}

export async function listProducts(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
  options: { search?: string; category?: string; lowOnly?: boolean; includeInactive?: boolean } = {},
): Promise<ProductRow[]> {
  requirePermission(permissions, 'inventory.product.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.product.findMany({
      // Bounded: more than 1,000 products in a gym shop for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 1000,
      where: {
        deletedAt: null,
        ...(options.includeInactive ? {} : { isActive: true }),
        ...(options.category ? { category: options.category } : {}),
        ...(options.search
          ? {
              OR: [
                { name: { contains: options.search, mode: 'insensitive' } },
                { sku: { contains: options.search, mode: 'insensitive' } },
                { barcode: { contains: options.search } },
              ],
            }
          : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        category: true,
        sku: true,
        unit: true,
        purchasePrice: true,
        sellingPrice: true,
        quantityOnHand: true,
        reorderLevel: true,
        isActive: true,
        taxRateId: true,
        taxRate: { select: { percentage: true } },
      },
    });

    const mapped = rows.map((row: any) => {
      const onHand = Number(row.quantityOnHand);
      const reorder = Number(row.reorderLevel);
      return {
        id: row.id,
        name: row.name,
        category: row.category,
        sku: row.sku,
        unit: row.unit,
        purchasePrice: Number(row.purchasePrice).toFixed(2),
        sellingPrice: Number(row.sellingPrice).toFixed(2),
        quantityOnHand: onHand.toString(),
        reorderLevel: reorder.toString(),
        // At the level counts as needing a reorder: a gym that waits for zero
        // has already turned somebody away.
        needsReorder: reorder > 0 && onHand <= reorder,
        isActive: row.isActive,
        taxRateId: row.taxRateId,
        taxPercentage: row.taxRate ? Number(row.taxRate.percentage).toFixed(2) : null,
      };
    });

    return options.lowOnly ? mapped.filter((p: ProductRow) => p.needsReorder) : mapped;
  });
}

export async function createProduct(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
  input: {
    name: string;
    category?: string;
    sku?: string;
    barcode?: string;
    unit?: string;
    purchasePrice?: string;
    sellingPrice: string;
    taxRateId?: string;
    reorderLevel?: string;
    openingStock?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ id: string }> {
  requirePermission(permissions, 'inventory.product.manage');

  return withTenant(ctx, async (tx) => {
    if (input.sku) {
      const clash = await tx.product.findFirst({
        where: { sku: input.sku.trim(), deletedAt: null },
        select: { id: true },
      });
      if (clash) {
        throw new AppError('CONFLICT', `Another product already uses the code ${input.sku.trim()}.`);
      }
    }

    // GST applies to what a gym sells over the counter, so a product with no
    // rate named takes the gym's default rather than silently charging none.
    const taxRateId =
      input.taxRateId ??
      (
        await tx.taxRate.findFirst({
          where: { isDefault: true, isActive: true },
          select: { id: true },
        })
      )?.id ??
      null;

    const opening = Number(input.openingStock ?? 0);

    const product = await tx.product.create({
      data: {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        category: input.category?.trim() || null,
        sku: input.sku?.trim() || null,
        barcode: input.barcode?.trim() || null,
        unit: input.unit?.trim() || 'piece',
        purchasePrice: input.purchasePrice ?? '0',
        sellingPrice: input.sellingPrice,
        taxRateId,
        reorderLevel: input.reorderLevel ?? '0',
        quantityOnHand: opening.toString(),
      },
      select: { id: true },
    });

    // Opening stock is a movement like any other: the ledger has to explain
    // the number on the shelf from the very first day.
    if (opening > 0) {
      await tx.stockMovement.create({
        data: {
          organizationId: ctx.organizationId,
          productId: product.id,
          movementType: 'PURCHASE',
          quantity: opening.toString(),
          unitPrice: input.purchasePrice ?? '0',
          balanceAfter: opening.toString(),
          referenceType: 'OPENING',
          notes: 'Opening stock',
          recordedByUserId: ctx.userId,
        },
      });
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'inventory.product.create',
      entityType: 'Product',
      entityId: product.id,
      summary: `Added ${input.name.trim()} to the shop`,
      ipAddress: meta.ipAddress,
    });

    return product;
  });
}

export async function updateProduct(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
  productId: string,
  input: {
    name?: string;
    category?: string | null;
    sku?: string | null;
    unit?: string;
    purchasePrice?: string;
    sellingPrice?: string;
    taxRateId?: string | null;
    reorderLevel?: string;
    isActive?: boolean;
  },
  meta: { ipAddress?: string } = {},
): Promise<void> {
  requirePermission(permissions, 'inventory.product.manage');

  await withTenant(ctx, async (tx) => {
    const existing = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'That product was not found.');

    // Deliberately not here: quantityOnHand. Stock changes through movements
    // so the ledger always explains the figure; typing over the total would
    // make it unexplainable, which is how shrinkage hides.
    await tx.product.update({
      where: { id: productId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.category !== undefined ? { category: input.category?.trim() || null } : {}),
        ...(input.sku !== undefined ? { sku: input.sku?.trim() || null } : {}),
        ...(input.unit !== undefined ? { unit: input.unit.trim() } : {}),
        ...(input.purchasePrice !== undefined ? { purchasePrice: input.purchasePrice } : {}),
        ...(input.sellingPrice !== undefined ? { sellingPrice: input.sellingPrice } : {}),
        ...(input.taxRateId !== undefined ? { taxRateId: input.taxRateId } : {}),
        ...(input.reorderLevel !== undefined ? { reorderLevel: input.reorderLevel } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'inventory.product.update',
      entityType: 'Product',
      entityId: productId,
      summary: `Edited ${existing.name}`,
      ipAddress: meta.ipAddress,
    });
  });
}

// ----------------------------------------------------------------- stock ---

export interface MovementRow {
  id: string;
  productId: string;
  productName: string;
  movementType: MovementType;
  quantity: string;
  balanceAfter: string;
  unitPrice: string | null;
  notes: string | null;
  occurredAt: string;
  recordedBy: string | null;
}

/**
 * Records stock arriving, being written off, or being corrected.
 *
 * A correction is signed: +3 found, -2 missing. It is never a new total,
 * because a total typed over the old one records that somebody disagreed
 * with the system without recording by how much or why.
 */
export async function recordMovement(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
  input: {
    productId: string;
    movementType: Exclude<MovementType, 'SALE'>;
    quantity: string;
    unitPrice?: string;
    notes?: string;
    branchId?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<{ balanceAfter: string }> {
  requirePermission(permissions, 'inventory.stock.manage');

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new AppError('VALIDATION_FAILED', 'Say how many — a correction of zero records nothing.', [
      { field: 'quantity', issue: 'Cannot be zero' },
    ]);
  }

  if (
    (input.movementType === 'PURCHASE' || input.movementType === 'RETURN') &&
    quantity < 0
  ) {
    throw new AppError('VALIDATION_FAILED', 'Stock coming in is a positive number.', [
      { field: 'quantity', issue: 'Must be positive' },
    ]);
  }
  if (input.movementType === 'WASTAGE' && quantity > 0) {
    throw new AppError('VALIDATION_FAILED', 'Wastage is written as a negative number.', [
      { field: 'quantity', issue: 'Must be negative' },
    ]);
  }
  if (input.movementType === 'WASTAGE' && !input.notes?.trim()) {
    // Stock leaving without a sale needs a reason attached, or the audit
    // trail cannot tell wastage from theft.
    throw new AppError('VALIDATION_FAILED', 'Say what happened to it.', [
      { field: 'notes', issue: 'Required for wastage' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const locked = await tx.$queryRawUnsafe<Array<{ id: string; quantityOnHand: string }>>(
      `SELECT id, "quantityOnHand"
         FROM products
        WHERE id = $1::uuid AND "organizationId" = $2::uuid AND "deletedAt" IS NULL
        FOR UPDATE`,
      input.productId,
      ctx.organizationId,
    );
    if (locked.length === 0) throw new AppError('NOT_FOUND', 'That product was not found.');

    const product = await tx.product.findFirstOrThrow({
      where: { id: input.productId },
      select: { id: true, name: true, unit: true },
    });

    const onHand = Number(locked[0]!.quantityOnHand);
    const balanceAfter = Number((onHand + quantity).toFixed(3));

    if (balanceAfter < 0) {
      throw new AppError(
        'CONFLICT',
        `There are only ${onHand} ${product.unit} of ${product.name} on hand.`,
      );
    }

    await tx.product.update({
      where: { id: input.productId },
      data: { quantityOnHand: balanceAfter.toString() },
    });

    await tx.stockMovement.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId ?? null,
        productId: input.productId,
        movementType: input.movementType,
        quantity: quantity.toString(),
        unitPrice: input.unitPrice ?? null,
        balanceAfter: balanceAfter.toString(),
        notes: input.notes?.trim() || null,
        recordedByUserId: ctx.userId,
      },
    });

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'inventory.stock.movement',
      entityType: 'Product',
      entityId: input.productId,
      summary: `${input.movementType.toLowerCase()} of ${quantity} ${product.unit} — ${
        product.name
      } now ${balanceAfter}`,
      ipAddress: meta.ipAddress,
    });

    return { balanceAfter: balanceAfter.toString() };
  });
}

export async function listMovements(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
  options: { productId?: string; limit?: number } = {},
): Promise<MovementRow[]> {
  requirePermission(permissions, 'inventory.product.read');

  return withTenant(ctx, async (tx) => {
    const rows = await tx.stockMovement.findMany({
      where: { ...(options.productId ? { productId: options.productId } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
      select: {
        id: true,
        productId: true,
        movementType: true,
        quantity: true,
        balanceAfter: true,
        unitPrice: true,
        notes: true,
        occurredAt: true,
        product: { select: { name: true } },
        recordedByUserId: true,
      },
    });

    const userIds = [...new Set(rows.map((r: any) => r.recordedByUserId).filter(Boolean))];
    const users = userIds.length
      ? await tx.user.findMany({
        // Bounded: more than 1,000 users for one gym is a data
        // problem, and a truncated list beats a request that times out.
        take: 1000,
          where: { id: { in: userIds as string[] } },
          select: { id: true, fullName: true },
        })
      : [];
    const names = new Map(users.map((u: any) => [u.id, u.fullName]));

    return rows.map((row: any) => ({
      id: row.id,
      productId: row.productId,
      productName: row.product.name,
      movementType: row.movementType as MovementType,
      quantity: Number(row.quantity).toString(),
      balanceAfter: Number(row.balanceAfter).toString(),
      unitPrice: row.unitPrice ? Number(row.unitPrice).toFixed(2) : null,
      notes: row.notes,
      occurredAt: row.occurredAt.toISOString(),
      recordedBy: row.recordedByUserId ? (names.get(row.recordedByUserId) ?? null) : null,
    }));
  });
}

// ------------------------------------------------------------ the counter ---

export interface CounterSaleLine {
  productId: string;
  quantity: string;
}

export interface CounterSaleResult {
  invoiceId: string;
  invoiceCode: string;
  total: string;
  tax: string;
  paid: string;
  due: string;
  receiptCode: string | null;
  lines: Array<{ name: string; quantity: string; lineTotal: string; stockLeft: string }>;
}

/**
 * A sale at the counter.
 *
 * It raises a real GST invoice rather than a private notion of a sale: what
 * a gym sells over the counter is a taxable supply, the invoice series is
 * gapless, and the accountant reconciles one set of documents instead of
 * two. The payment, where one is taken, goes through the same payments table
 * as a membership, so "collected today" is the whole till rather than the
 * membership half of it.
 *
 * Every line locks its product row before deciding, so the last protein bar
 * cannot be sold twice. Out of stock refuses the sale outright: selling what
 * is not there means handing a customer an invoice for something the gym
 * cannot give them.
 */
export async function recordCounterSale(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
  input: {
    lines: CounterSaleLine[];
    memberId?: string;
    customerName?: string;
    branchId?: string;
    payment?: { amount: string; method: string; referenceNumber?: string };
    notes?: string;
  },
  meta: { ipAddress?: string } = {},
): Promise<CounterSaleResult> {
  requirePermission(permissions, 'inventory.stock.manage');
  requirePermission(permissions, 'finance.payment.create');

  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Add something to the sale first.', [
      { field: 'lines', issue: 'At least one product' },
    ]);
  }

  return withTenant(ctx, async (tx) => {
    const settings = await tx.orgSetting.findFirst({ select: { gstin: true } });

    let member: { id: string; branchId: string | null; name: string } | null = null;
    if (input.memberId) {
      const found = await tx.member.findFirst({
        where: { id: input.memberId, deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true },
      });
      if (!found) throw new AppError('NOT_FOUND', 'That member was not found.');
      member = {
        id: found.id,
        branchId: found.branchId,
        name: `${found.firstName} ${found.lastName ?? ''}`.trim(),
      };
    }

    const branchId = input.branchId ?? member?.branchId ?? null;

    let taxablePaise = 0;
    let taxPaise = 0;
    let totalPaise = 0;

    const lineData: any[] = [];
    const summary: CounterSaleResult['lines'] = [];

    for (const line of input.lines) {
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new AppError('VALIDATION_FAILED', 'Each line needs a quantity.', [
          { field: 'lines', issue: 'Quantity must be more than zero' },
        ]);
      }

      const locked = await tx.$queryRawUnsafe<Array<{ id: string; quantityOnHand: string }>>(
        `SELECT id, "quantityOnHand"
           FROM products
          WHERE id = $1::uuid AND "organizationId" = $2::uuid AND "deletedAt" IS NULL
          FOR UPDATE`,
        line.productId,
        ctx.organizationId,
      );
      if (locked.length === 0) throw new AppError('NOT_FOUND', 'That product was not found.');

      const product = await tx.product.findFirstOrThrow({
        where: { id: line.productId },
        select: {
          id: true,
          name: true,
          unit: true,
          sellingPrice: true,
          isActive: true,
          taxRateId: true,
          taxRate: { select: { id: true, percentage: true } },
        },
      });

      if (!product.isActive) {
        throw new AppError('CONFLICT', `${product.name} is no longer sold.`);
      }

      const onHand = Number(locked[0]!.quantityOnHand);
      if (onHand < quantity) {
        throw new AppError(
          'CONFLICT',
          onHand === 0
            ? `${product.name} is out of stock.`
            : `Only ${onHand} ${product.unit} of ${product.name} left.`,
        );
      }

      // Prices on the shelf include tax in India, so the rate is split out
      // of the marked price rather than added to it.
      // Prisma hands Decimal back as an object, not a string: toPaise takes
      // the printed value, which is exact for a fixed-scale column.
      const grossPaise = toPaise(product.sellingPrice.toString()) * quantity;
      const tax = splitTax(Math.round(grossPaise), product.taxRate, { inclusive: true });

      taxablePaise += tax.taxable;
      taxPaise += tax.tax;
      totalPaise += tax.total;

      const balanceAfter = Number((onHand - quantity).toFixed(3));

      await tx.product.update({
        where: { id: product.id },
        data: { quantityOnHand: balanceAfter.toString() },
      });

      lineData.push({
        organizationId: ctx.organizationId,
        description: `${product.name} × ${quantity} ${product.unit}`,
        itemType: 'PRODUCT',
        productId: product.id,
        quantity: quantity.toString(),
        unitPrice: toRupees(Math.round(tax.taxable / quantity)),
        taxRateId: product.taxRateId,
        taxPercentage: tax.ratePercent,
        taxAmount: toRupees(tax.tax),
        lineTotal: toRupees(tax.total),
        displayOrder: lineData.length,
      });

      summary.push({
        name: product.name,
        quantity: quantity.toString(),
        lineTotal: toRupees(tax.total),
        stockLeft: balanceAfter.toString(),
      });
    }

    const paidPaise = input.payment ? toPaise(input.payment.amount) : 0;
    if (paidPaise > totalPaise) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That payment is more than the amount due. Record the correct amount.',
        [{ field: 'payment.amount', issue: `Due is ${toRupees(totalPaise)}` }],
      );
    }
    // A walk-in cannot owe the gym money: there is no account to chase it on.
    if (!member && paidPaise < totalPaise) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A sale to someone who is not a member has to be paid in full.',
        [{ field: 'payment.amount', issue: `Due is ${toRupees(totalPaise)}` }],
      );
    }

    const allocated = await allocateInvoiceNumber(tx, {
      organizationId: ctx.organizationId,
      at: today(),
    });
    const duePaise = totalPaise - paidPaise;

    const invoice = await tx.invoice.create({
      data: {
        organizationId: ctx.organizationId,
        branchId,
        memberId: member?.id ?? null,
        series: allocated.series,
        financialYear: allocated.financialYear,
        invoiceNumber: allocated.number,
        invoiceCode: allocated.code,
        status: duePaise === 0 ? 'PAID' : paidPaise > 0 ? 'PARTIALLY_PAID' : 'ISSUED',
        issueDate: today(),
        dueDate: today(),
        subtotal: toRupees(taxablePaise),
        discountAmount: '0',
        taxAmount: toRupees(taxPaise),
        total: toRupees(totalPaise),
        amountPaid: toRupees(paidPaise),
        amountDue: toRupees(duePaise),
        notes: [
          input.customerName && !member ? `Counter sale — ${input.customerName.trim()}` : null,
          input.notes?.trim() || null,
          settings?.gstin ? `GSTIN ${settings.gstin}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
        createdByUserId: ctx.userId,
        lines: { create: lineData },
      },
      select: { id: true, invoiceCode: true },
    });

    // The movements, now that the invoice they belong to exists.
    for (let index = 0; index < input.lines.length; index += 1) {
      const line = input.lines[index]!;
      const left = summary[index]!.stockLeft;
      await tx.stockMovement.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          productId: line.productId,
          movementType: 'SALE',
          quantity: (-Number(line.quantity)).toString(),
          unitPrice: lineData[index]!.unitPrice,
          balanceAfter: left,
          referenceType: 'Invoice',
          referenceId: invoice.id,
          recordedByUserId: ctx.userId,
        },
      });
    }

    let receiptCode: string | null = null;

    if (input.payment && paidPaise > 0) {
      const receipt = await allocateReceiptNumber(tx, ctx.organizationId, today());
      receiptCode = receipt.code;

      await tx.payment.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          memberId: member?.id ?? null,
          invoiceId: invoice.id,
          receiptCode: receipt.code,
          amount: toRupees(paidPaise),
          method: input.payment.method as never,
          status: 'CAPTURED',
          referenceNumber: input.payment.referenceNumber ?? null,
          notes: member ? null : (input.customerName?.trim() ?? 'Counter sale'),
          recordedByUserId: ctx.userId,
        },
      });
    }

    await writeAudit(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'inventory.sale.create',
      entityType: 'Invoice',
      entityId: invoice.id,
      summary: `Counter sale ${invoice.invoiceCode} — ${toRupees(totalPaise)}${
        member ? ` to ${member.name}` : ''
      }`,
      after: { lines: summary.length, total: toRupees(totalPaise) },
      ipAddress: meta.ipAddress,
    });

    return {
      invoiceId: invoice.id,
      invoiceCode: invoice.invoiceCode,
      total: toRupees(totalPaise),
      tax: toRupees(taxPaise),
      paid: toRupees(paidPaise),
      due: toRupees(duePaise),
      receiptCode,
      lines: summary,
    };
  });
}

// ------------------------------------------------------------- the shop ---

export interface ShopSummary {
  productCount: number;
  lowStockCount: number;
  stockValue: string;
  soldToday: string;
  itemsSoldToday: number;
}

/**
 * What the shop is doing: stock on hand at cost, what is running out, and
 * what the counter took today — the numbers a gym owner asks about.
 */
export async function shopSummary(
  ctx: InventoryContext,
  permissions: ResolvedPermissions,
): Promise<ShopSummary> {
  requirePermission(permissions, 'inventory.product.read');

  return withTenant(ctx, async (tx) => {
    const settings = await tx.orgSetting.findFirst({ select: { timezone: true } });
    const day = businessDayRange(settings?.timezone ?? 'Asia/Kolkata');

    const products = await tx.product.findMany({
      // Bounded: more than 1,000 products in a gym shop for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 1000,
      where: { deletedAt: null, isActive: true },
      select: { quantityOnHand: true, reorderLevel: true, purchasePrice: true },
    });

    const sales = await tx.stockMovement.findMany({
      // Bounded: more than 5,000 stock movements for one gym is a data
      // problem, and a truncated list beats a request that times out.
      take: 5000,
      where: {
        movementType: 'SALE',
        occurredAt: { gte: day.start, lt: day.end },
      },
      select: { quantity: true, unitPrice: true },
    });

    const stockValue = products.reduce(
      (sum: number, p: any) => sum + Number(p.quantityOnHand) * Number(p.purchasePrice),
      0,
    );

    const soldToday = sales.reduce(
      (sum: number, s: any) => sum + Math.abs(Number(s.quantity)) * Number(s.unitPrice ?? 0),
      0,
    );

    return {
      productCount: products.length,
      lowStockCount: products.filter(
        (p: any) => Number(p.reorderLevel) > 0 && Number(p.quantityOnHand) <= Number(p.reorderLevel),
      ).length,
      stockValue: stockValue.toFixed(2),
      soldToday: soldToday.toFixed(2),
      itemsSoldToday: sales.reduce((sum: number, s: any) => sum + Math.abs(Number(s.quantity)), 0),
    };
  });
}
