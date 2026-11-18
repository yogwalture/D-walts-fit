import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteExpense } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

const body = z.object({ reason: z.string().trim().max(300).optional() });

/** Soft delete, so a corrected mistake stays in the audit trail. */
export const DELETE = route(
  { permission: 'finance.expense.manage', schema: body },
  async ({ input, actor, params, ipAddress }) => {
    await deleteExpense(tenantOf(actor), actor.permissions, params.id!, {
      reason: input.reason,
      ipAddress,
    });
    return NextResponse.json({ data: { removed: true } }, { status: 200 });
  },
);
