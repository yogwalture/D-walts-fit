import { z } from 'zod';

export const planChangeInput = z.object({
  planKey: z.enum(['STARTER', 'GROWTH', 'PROFESSIONAL', 'ENTERPRISE']),
  reason: z.string().trim().max(300).optional(),
});

export const planAssessmentQuery = z.object({
  planKey: z.enum(['STARTER', 'GROWTH', 'PROFESSIONAL', 'ENTERPRISE']),
});
