import { listExpenseCategories } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Seeds a sensible default set on first read, so the list is never empty. */
export const GET = route({ permission: 'finance.expense.read' }, async ({ actor }) =>
  listExpenseCategories(tenantOf(actor), actor.permissions),
);
