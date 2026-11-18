import { z } from 'zod';
import { email, isoDate, isoDateTime, pageQuery, phone, uuid } from './common';

/**
 * Leads.
 *
 * `nextFollowUpAt` is deliberately not optional on most of these: an enquiry
 * with no next date is the one that gets forgotten, so the server defaults
 * it rather than allowing none.
 */

export const leadSource = z.enum([
  'WALK_IN',
  'WEBSITE',
  'REFERRAL',
  'INSTAGRAM',
  'FACEBOOK',
  'WHATSAPP',
  'TELEPHONE',
  'OTHER',
]);

export const leadStatus = z.enum([
  'NEW',
  'CONTACTED',
  'FOLLOW_UP',
  'TRIAL_BOOKED',
  'NEGOTIATION',
  'CONVERTED',
  'LOST',
]);

export const createLeadInput = z.object({
  fullName: z.string().trim().min(2, 'Enter a name').max(160),
  phone,
  email: email.optional(),
  city: z.string().trim().max(100).optional(),
  source: leadSource.default('WALK_IN'),
  sourceDetail: z.string().trim().max(200).optional(),
  interestedPlanId: uuid.optional(),
  budgetNote: z.string().trim().max(300).optional(),
  branchId: uuid.optional(),
  assignedToOrgUserId: uuid.optional(),
  nextFollowUpAt: isoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Set after the duplicate warning has been seen — families share numbers. */
  allowDuplicate: z.boolean().default(false),
});

export const updateLeadInput = createLeadInput
  .omit({ allowDuplicate: true })
  .partial()
  .extend({
    /** CONVERTED is refused here: converting creates a member and is its own call. */
    status: leadStatus.exclude(['CONVERTED']).optional(),
    lostReason: z.string().trim().max(300).optional(),
  });

export const leadListQuery = pageQuery.extend({
  filter: z
    .enum(['all', 'open', 'overdue', 'today', 'unassigned', 'converted', 'lost'])
    .default('open'),
  status: z.union([leadStatus, z.literal('all')]).optional(),
  assignedToOrgUserId: uuid.optional(),
  branchId: uuid.optional(),
});

/**
 * Logging a call, and setting the next follow-up in the same action.
 *
 * Together on purpose: a follow-up that has to be scheduled as a separate
 * step is one that does not get scheduled.
 */
export const logActivityInput = z.object({
  leadId: uuid,
  activityType: z.enum(['CALL', 'WHATSAPP', 'SMS', 'EMAIL', 'VISIT', 'NOTE', 'TRIAL']),
  outcome: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Null clears it; omitted leaves it alone. */
  nextFollowUpAt: isoDate.nullable().optional(),
  status: leadStatus.exclude(['CONVERTED']).optional(),
});

export const convertLeadInput = z.object({
  leadId: uuid,
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  email: email.optional(),
  allowDuplicate: z.boolean().default(false),
});

export const bookTrialInput = z.object({
  leadId: uuid,
  scheduledFor: isoDateTime,
  trainerOrgUserId: uuid.optional(),
});

export const trialOutcomeInput = z.object({
  bookingId: uuid,
  attended: z.boolean(),
  feedback: z.string().trim().max(1000).optional(),
});

export const pipelineQuery = z.object({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadInput>;
export type LeadListQuery = z.infer<typeof leadListQuery>;
