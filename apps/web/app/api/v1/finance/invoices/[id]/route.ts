import { getInvoiceDocument } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route({ permission: 'finance.invoice.read' }, async ({ actor, params }) =>
  getInvoiceDocument(tenantOf(actor), actor.permissions, params.id!),
);
