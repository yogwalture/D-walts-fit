import { z } from 'zod';
import { email, isoDate, pageQuery, phone, uuid } from './common';

/**
 * Members.
 *
 * Reception types these in while someone waits at the desk, so the required
 * set is deliberately tiny: a first name and a phone number. Everything else
 * can be filled in later from the member's own profile.
 */

export const gender = z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']);
export const bloodGroup = z.enum(['A_POS', 'A_NEG', 'B_POS', 'B_NEG', 'O_POS', 'O_NEG', 'AB_POS', 'AB_NEG']);

/**
 * The fields are flat, matching the columns and the service exactly.
 *
 * Nesting them as `address: { … }` read better, and silently dropped every
 * address the desk typed: the service takes `addressLine1`, Zod stripped the
 * unknown key, and TypeScript could not see it because every one of these is
 * optional. Flat is harder to get wrong.
 */
export const createMemberInput = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name').max(80),
  lastName: z.string().trim().max(80).optional(),
  phone,
  altPhone: phone.optional(),
  email: email.optional(),
  dateOfBirth: isoDate.optional(),
  gender: gender.optional(),
  bloodGroup: bloodGroup.optional(),
  branchId: uuid.optional(),
  joiningDate: isoDate.optional(),
  assignedTrainerOrgUserId: uuid.optional(),

  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter a 6-digit PIN code')
    .optional(),

  emergencyContactName: z.string().trim().max(120).optional(),
  emergencyContactPhone: phone.optional(),
  emergencyContactRelation: z.string().trim().max(60).optional(),

  fitnessGoals: z.array(z.string().trim().max(120)).max(20).optional(),
  occupation: z.string().trim().max(120).optional(),
  referredBy: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  /**
   * Set only after reception has seen the duplicate warning and decided to
   * proceed anyway — families share phone numbers, so this is a real case
   * rather than an escape hatch.
   */
  allowDuplicate: z.boolean().default(false),
});

export const updateMemberInput = createMemberInput
  .omit({ allowDuplicate: true })
  .partial()
  .extend({
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
  });

export const memberListQuery = pageQuery.omit({ sortBy: true }).extend({
  filter: z
    .enum(['all', 'active', 'expiring', 'expired', 'inactive', 'unpaid'])
    .default('all'),
  branchId: uuid.optional(),
  /** An organisation-user id, so a trainer's own list is one query. */
  trainerOrgUserId: uuid.optional(),
  sortBy: z.enum(['name', 'joined', 'expiry', 'code']).optional(),
});

export const archiveMemberInput = z.object({
  reason: z.string().trim().min(3, 'Record why this member is being archived').max(500),
});

export const medicalDeclarationInput = z.object({
  hasDeclaredConditions: z.boolean(),
  conditions: z.array(z.string().trim().max(120)).max(30).default([]),
  medications: z.array(z.string().trim().max(120)).max(30).default([]),
  injuries: z.string().trim().max(1000).optional(),
  allergies: z.string().trim().max(500).optional(),
  physicianClearance: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional(),
});

/** Bulk import: the file is parsed server-side, previewed, then committed. */
export const importPreviewQuery = z.object({
  sheet: z.string().max(100).optional(),
});

export const importCommitInput = z.object({
  uploadId: uuid,
  /** Rows the user unticked in the preview are skipped. */
  skipRows: z.array(z.number().int().min(0)).max(10_000).default([]),
  allowDuplicates: z.boolean().default(false),
});

export type CreateMemberInput = z.infer<typeof createMemberInput>;
export type UpdateMemberInput = z.infer<typeof updateMemberInput>;
export type MemberListQuery = z.infer<typeof memberListQuery>;
export type MedicalDeclarationInput = z.infer<typeof medicalDeclarationInput>;
