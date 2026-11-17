import { z } from 'zod';
import { isoDate, money, pageQuery, uuid } from './common';

/**
 * Plans, the sale, and everything that happens to a membership afterwards.
 *
 * Every schema that moves money or dates demands the reason alongside it:
 * an extension or a cancellation without a recorded reason is how a gym
 * loses the thread of its own revenue.
 */

export const durationUnit = z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR', 'SESSION']);

/**
 * Mirrors the PaymentMethod enum in the schema, exactly.
 *
 * Netbanking arrives through Razorpay rather than as its own method: the
 * gym never sees which rail the gateway used, only that the gateway paid.
 */
export const paymentMethod = z.enum([
  'CASH',
  'UPI',
  'CARD',
  'CHEQUE',
  'BANK_TRANSFER',
  'RAZORPAY',
  'WALLET',
  'OTHER',
]);

export const planCategory = z.enum([
  'GENERAL',
  'PERSONAL_TRAINING',
  'GROUP_TRAINING',
  'FAMILY',
  'STUDENT',
  'CORPORATE',
  'DAY_PASS',
  'CUSTOM',
]);

export const createPlanInput = z.object({
  name: z.string().trim().min(2, 'Give the plan a name').max(120),
  description: z.string().trim().max(1000).optional(),
  category: planCategory.optional(),
  durationUnit,
  durationValue: z.coerce.number().int().min(1).max(120),
  /** Required when the unit is SESSION: the package is consumed, not timed. */
  sessionCount: z.coerce.number().int().min(1).max(1000).optional(),
  price: money,
  /**
   * Omitted, the gym's default tax rate applies — GST applies to a gym
   * membership in India, and a plan that quietly charges 0% is an
   * under-collection nobody notices until filing. Send null for a plan that
   * is deliberately tax-free.
   */
  taxRateId: uuid.nullable().optional(),
  priceIncludesTax: z.boolean().default(true),
  joiningFee: money.optional(),
  graceDays: z.coerce.number().int().min(0).max(90).default(0),
  freezeAllowed: z.boolean().default(false),
  freezeMaxDays: z.coerce.number().int().min(0).max(365).default(0),
  transferAllowed: z.boolean().default(false),
  discountAllowed: z.boolean().default(true),
  branchIds: z.array(uuid).max(50).default([]),
  includedServices: z.array(z.string().trim().max(120)).max(30).default([]),
  visibleToMembers: z.boolean().default(true),
});

export const updatePlanInput = createPlanInput.partial().extend({
  isActive: z.boolean().optional(),
});

export const planQuoteQuery = z.object({
  planId: uuid,
  startDate: isoDate.optional(),
  /** A discount coupon the gym has configured, by code. */
  discountCode: z.string().trim().max(40).optional(),
  /** A negotiated price, which replaces the plan's list price entirely. */
  overridePrice: money.optional(),
});

/** The payment taken at the counter alongside the sale, when there is one. */
export const salePaymentInput = z.object({
  amount: money,
  method: paymentMethod,
  referenceNumber: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(500).optional(),
  receivedAt: isoDate.optional(),
});

/**
 * Selling or renewing a membership.
 *
 * A discount is either a configured coupon (`discountCode`) or a negotiated
 * price (`overridePrice`) — never an ad-hoc percentage typed at the counter,
 * so every reduction is either traceable to a coupon or recorded as the price
 * actually agreed.
 */
export const sellMembershipInput = z.object({
  memberId: uuid,
  planId: uuid,
  startDate: isoDate.optional(),
  branchId: uuid.optional(),
  discountCode: z.string().trim().max(40).optional(),
  overridePrice: money.optional(),
  payment: salePaymentInput.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const freezeInput = z.object({
  subscriptionId: uuid,
  fromDate: isoDate,
  toDate: isoDate,
  reason: z.string().trim().max(300).optional(),
});

export const unfreezeInput = z.object({
  subscriptionId: uuid,
  /** Defaults to today; a receptionist catching up can backdate it. */
  asOf: isoDate.optional(),
});

export const extendInput = z.object({
  subscriptionId: uuid,
  days: z.coerce.number().int().min(1).max(365),
  reason: z.string().trim().min(3, 'Record why the membership is being extended').max(300),
});

export const cancelInput = z.object({
  subscriptionId: uuid,
  reason: z.string().trim().min(3, 'Record why the membership is being cancelled').max(300),
  refundAmount: money.optional(),
  refundMethod: paymentMethod.optional(),
});

/**
 * Moves a membership to another branch of the same gym.
 *
 * Transferring a membership to a different PERSON is a separate thing and is
 * not built yet; `MembershipPlan.transferAllowed` gates it and nothing reads
 * that flag for this endpoint.
 */
export const transferInput = z.object({
  subscriptionId: uuid,
  toBranchId: uuid,
  reason: z.string().trim().min(3, 'Record why the membership is being transferred').max(300),
});

export const subscriptionListQuery = pageQuery.extend({
  /** `live` is active plus frozen: everything the gym still owes service on. */
  status: z.enum(['live', 'ACTIVE', 'FROZEN', 'EXPIRED', 'CANCELLED', 'all']).default('live'),
  planId: uuid.optional(),
  branchId: uuid.optional(),
  memberId: uuid.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type CreatePlanInput = z.infer<typeof createPlanInput>;
export type SellMembershipInput = z.infer<typeof sellMembershipInput>;
export type PaymentMethod = z.infer<typeof paymentMethod>;
