import { z } from 'zod';
import { isoDate, money, pageQuery, uuid } from './common';
import { paymentMethod } from './memberships';

/**
 * Payments, invoices and the dashboard's date filter.
 *
 * Note what is absent: no card number, CVV, expiry or cardholder name
 * appears anywhere in this file, because none of it is ever sent to this
 * server. Card payments go to Razorpay's own checkout and come back as a
 * signed order reference.
 */

/**
 * What reception can take at the counter.
 *
 * RAZORPAY is deliberately absent. A gateway payment is only ever marked
 * captured by the webhook, after its signature has been verified
 * server-side — so there must be no route by which a client can assert one
 * was received. Omitting it here makes that a validation error rather than a
 * convention someone can forget.
 */
export const counterPaymentMethod = paymentMethod.exclude(['RAZORPAY']);

export const recordPaymentInput = z.object({
  memberId: uuid,
  invoiceId: uuid.optional(),
  subscriptionId: uuid.optional(),
  branchId: uuid.optional(),
  amount: money,
  method: counterPaymentMethod,
  referenceNumber: z.string().trim().max(60).optional(),
  receivedAt: isoDate.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const paymentListQuery = pageQuery.extend({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  method: paymentMethod.optional(),
  branchId: uuid.optional(),
  memberId: uuid.optional(),
  collectedBy: uuid.optional(),
});

export const invoiceListQuery = pageQuery.extend({
  status: z
    .enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'all'])
    .default('all'),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  memberId: uuid.optional(),
  branchId: uuid.optional(),
});

export const refundRequestInput = z.object({
  paymentId: uuid,
  amount: money,
  reason: z.string().trim().min(3, 'Record why this is being refunded').max(500),
  method: paymentMethod.optional(),
});

export const expenseInput = z.object({
  categoryId: uuid.optional(),
  amount: money,
  spentOn: isoDate,
  vendor: z.string().trim().max(160).optional(),
  description: z.string().trim().max(500).optional(),
  branchId: uuid.optional(),
  method: paymentMethod.optional(),
  referenceNumber: z.string().trim().max(60).optional(),
});

/**
 * The dashboard's date filter.
 *
 * Named ranges rather than only a date pair, because the owner's question is
 * "how was last month", and a named range survives being bookmarked.
 */
export const dateRange = z.enum([
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'thisFinancialYear',
  'custom',
]);

export const dashboardQuery = z
  .object({
    range: dateRange.default('last30'),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
    branchId: uuid.optional(),
  })
  .refine((v) => v.range !== 'custom' || (v.fromDate && v.toDate), {
    message: 'Pick both dates for a custom range',
    path: ['fromDate'],
  })
  .refine((v) => !v.fromDate || !v.toDate || v.fromDate <= v.toDate, {
    message: 'The start date must come before the end date',
    path: ['fromDate'],
  });

export const chartsQuery = z.object({
  months: z.coerce.number().int().min(3).max(24).default(6),
  branchId: uuid.optional(),
});

/** A Razorpay order is created server-side; the client only gets the id. */
export const createGatewayOrderInput = z.object({
  invoiceId: uuid,
});

export type RecordPaymentInput = z.infer<typeof recordPaymentInput>;
export type DashboardQuery = z.infer<typeof dashboardQuery>;
export type DateRange = z.infer<typeof dateRange>;
