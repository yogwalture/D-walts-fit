import { z } from 'zod';
import { email, phone, uuid } from './common';

/**
 * Password policy: length over composition rules. A long passphrase beats
 * "P@ssw0rd!" and people actually remember it. Breached-password checking
 * happens server-side at registration and change time.
 */
export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((v) => v.trim().length >= 12, 'Spaces alone do not count');

export const loginInput = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
  /** Present on the second step when the account has MFA enabled. */
  totp: z.string().regex(/^\d{6}$/).optional(),
  rememberDevice: z.boolean().default(false),
});

export const memberOtpRequestInput = z.object({
  identifier: z.union([email, phone]),
  organizationSlug: z.string().min(1),
});

export const memberOtpVerifyInput = z.object({
  identifier: z.union([email, phone]),
  organizationSlug: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});

export const forgotPasswordInput = z.object({ email });

export const resetPasswordInput = z.object({
  token: z.string().min(32),
  password,
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1),
  password,
});

export const acceptInvitationInput = z.object({
  token: z.string().min(32),
  fullName: z.string().trim().min(2).max(120),
  password,
});

export const switchOrganizationInput = z.object({ organizationId: uuid });

export const enableMfaInput = z.object({ totp: z.string().regex(/^\d{6}$/) });

/**
 * Self-serve gym registration. Creates the tenant, its first branch, the
 * owner account and a trial subscription in one transaction.
 */
export const registerGymInput = z.object({
  gymName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email,
  phone,
  password,
  city: z.string().trim().min(2).max(80).optional(),
  planKey: z.enum(['STARTER', 'GROWTH', 'PROFESSIONAL', 'ENTERPRISE']).default('STARTER'),
  acceptedTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms to continue' }),
  }),
});

export type LoginInput = z.infer<typeof loginInput>;
export type RegisterGymInput = z.infer<typeof registerGymInput>;
export type SwitchOrganizationInput = z.infer<typeof switchOrganizationInput>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationInput>;

/** What /api/v1/session returns. The client builds its whole UI from this. */
export interface SessionView {
  user: {
    id: string;
    email: string;
    fullName: string;
    mfaEnabled: boolean;
    isPlatformAdmin: boolean;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
    branding: { displayName: string | null; primaryColor: string; accentColor: string };
  } | null;
  role: { key: string; name: string } | null;
  /** Resolved permission keys mapped to their scope. */
  permissions: Record<string, 'ALL' | 'BRANCH' | 'OWN'>;
  branchIds: string[];
  /** Every organization this user may switch into. */
  memberships: Array<{ organizationId: string; name: string; slug: string; roleKey: string }>;
}

export const inviteStaffInput = z.object({
  email,
  fullName: z.string().trim().min(2).max(120),
  roleId: uuid,
  branchIds: z.array(uuid).max(50).default([]),
});

export const setStaffStatusInput = z.object({
  orgUserId: uuid,
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export const changeStaffRoleInput = z.object({
  orgUserId: uuid,
  roleId: uuid,
});

export const disableMfaInput = z.object({
  password: z.string().min(1),
});

export const setGymStatusInput = z.object({
  organizationId: uuid,
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: z.string().trim().max(500).optional(),
});

export type InviteStaffInput = z.infer<typeof inviteStaffInput>;
