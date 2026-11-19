import { z } from 'zod';
import { boolish, isoDateTime, uuid } from './common';

export const channel = z.enum(['WHATSAPP', 'PUSH', 'EMAIL', 'SMS', 'IN_APP']);
export const messageCategory = z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE']);
export const approvalStatus = z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED']);

export const templateInput = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(120),
  channel: channel.default('WHATSAPP'),
  category: messageCategory.default('UTILITY'),
  language: z.string().trim().max(10).default('en'),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(5, 'Write the message').max(1024),
  /** The name Meta approved it under — not the gym's own label for it. */
  providerTemplateName: z.string().trim().max(120).optional(),
});

export const updateTemplateInput = z.object({
  templateId: uuid,
  name: z.string().trim().min(2).max(120).optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(5).max(1024).optional(),
  category: messageCategory.optional(),
  providerTemplateName: z.string().trim().max(120).nullable().optional(),
  approvalStatus: approvalStatus.optional(),
  approvalNote: z.string().trim().max(300).nullable().optional(),
  isActive: boolish.optional(),
});

export const audienceFilter = z.object({
  kind: z.enum(['all', 'active', 'expiring', 'expired', 'leads', 'selected']).default('active'),
  memberIds: z.array(uuid).max(5000).optional(),
  branchId: uuid.optional(),
  withinDays: z.coerce.number().int().min(1).max(90).optional(),
});

export const campaignInput = z.object({
  name: z.string().trim().min(2, 'Name this campaign').max(120),
  templateId: uuid,
  audience: audienceFilter,
  scheduledAt: isoDateTime.optional(),
});

export const whatsappSettingsInput = z.object({
  wabaId: z.string().trim().max(60).optional(),
  phoneNumberId: z.string().trim().min(5, 'From Meta’s WhatsApp settings').max(60),
  /** Omitted means "keep the token already stored". */
  accessToken: z.string().trim().min(20).max(500).optional(),
  businessName: z.string().trim().max(120).optional(),
  webhookVerifyToken: z.string().trim().max(120).optional(),
});

export const preferenceInput = z.object({
  subjectType: z.enum(['MEMBER', 'LEAD', 'USER']),
  subjectId: uuid,
  channel: channel.default('WHATSAPP'),
  category: messageCategory.default('MARKETING'),
  optedIn: boolish,
  source: z.string().trim().max(120).optional(),
});

export type TemplateInput = z.infer<typeof templateInput>;
export type CampaignInput = z.infer<typeof campaignInput>;
