import { NextResponse } from 'next/server';
import { counterSaleInput } from '@gym/contracts';
import { recordCounterSale } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * A sale at the counter, which raises a real GST invoice rather than a
 * private notion of a receipt.
 */
export const POST = route(
  { permission: 'inventory.stock.manage', schema: counterSaleInput },
  async ({ input, actor, ipAddress }) => {
    const sale = await recordCounterSale(
      tenantOf(actor),
      actor.permissions,
      {
        lines: input.lines,
        memberId: input.memberId,
        customerName: input.customerName,
        branchId: input.branchId,
        payment: input.payment,
        notes: input.notes,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: sale }, { status: 201 });
  },
);
