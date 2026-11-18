import { z } from 'zod';
import { money, uuid } from './common';
import { counterPaymentMethod } from './finance';

/**
 * Products, stock and the counter.
 *
 * Quantities are decimal strings, not integers: a gym sells 0.5 kg of
 * something as readily as two bottles, and the column holds three decimals.
 */

export const quantity = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .pipe(z.string().regex(/^-?\d{1,9}(\.\d{1,3})?$/, 'Enter a quantity'));

export const stockMovementType = z.enum([
  'PURCHASE',
  'ADJUSTMENT',
  'WASTAGE',
  'RETURN',
  'TRANSFER',
]);

export const productInput = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(120),
  category: z.string().trim().max(60).optional(),
  sku: z.string().trim().max(40).optional(),
  barcode: z.string().trim().max(60).optional(),
  unit: z.string().trim().max(20).default('piece'),
  purchasePrice: money.optional(),
  sellingPrice: money,
  taxRateId: uuid.optional(),
  reorderLevel: quantity.optional(),
  openingStock: quantity.optional(),
});

export const updateProductInput = productInput
  .partial()
  .omit({ openingStock: true })
  .extend({ isActive: z.coerce.boolean().optional() });

export const productListQuery = z.object({
  search: z.string().trim().max(80).optional(),
  category: z.string().trim().max(60).optional(),
  lowOnly: z.coerce.boolean().default(false),
  includeInactive: z.coerce.boolean().default(false),
});

export const stockMovementInput = z.object({
  productId: uuid,
  movementType: stockMovementType,
  quantity,
  unitPrice: money.optional(),
  notes: z.string().trim().max(300).optional(),
  branchId: uuid.optional(),
});

export const counterSaleInput = z
  .object({
    lines: z
      .array(z.object({ productId: uuid, quantity }))
      .min(1, 'Add something to the sale')
      .max(50),
    memberId: uuid.optional(),
    customerName: z.string().trim().max(120).optional(),
    branchId: uuid.optional(),
    payment: z
      .object({
        amount: money,
        /** RAZORPAY is excluded: the counter cannot claim a gateway payment. */
        method: counterPaymentMethod,
        referenceNumber: z.string().trim().max(80).optional(),
      })
      .optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((value) => value.memberId !== undefined || value.payment !== undefined, {
    message: 'A sale to someone who is not a member has to be paid for',
    path: ['payment'],
  });

export type ProductInput = z.infer<typeof productInput>;
export type StockMovementInput = z.infer<typeof stockMovementInput>;
export type CounterSaleInput = z.infer<typeof counterSaleInput>;
