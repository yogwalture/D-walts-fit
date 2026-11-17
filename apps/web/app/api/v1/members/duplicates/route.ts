import { z } from 'zod';
import { email, phone } from '@gym/contracts';
import { findDuplicates } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const query = z.object({
  phone,
  email: email.optional(),
  excludeMemberId: z.string().uuid().optional(),
});

/**
 * Checked as reception types, so the duplicate warning appears before the
 * form is submitted rather than as a rejection afterwards.
 */
export const GET = route(
  { permission: 'members.member.read', source: 'query', schema: query },
  async ({ input, actor }) => findDuplicates(tenantOf(actor), input),
);
