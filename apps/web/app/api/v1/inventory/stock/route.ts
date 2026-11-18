import { NextResponse } from 'next/server';
import { stockMovementInput } from '@gym/contracts';
import { listMovements, recordMovement } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'inventory.product.read' },
  async ({ request, actor }) => {
    const params = new URL(request.url).searchParams;
    const rows = await listMovements(tenantOf(actor), actor.permissions, {
      productId: params.get('productId') ?? undefined,
      limit: Number(params.get('limit') ?? 50) || 50,
    });
    return NextResponse.json({ data: rows });
  },
);

/**
 * Stock in, written off, or corrected. A correction is a signed difference,
 * never a new total — see the service for why.
 */
export const POST = route(
  { permission: 'inventory.stock.manage', schema: stockMovementInput },
  async ({ input, actor, ipAddress }) => {
    const result = await recordMovement(
      tenantOf(actor),
      actor.permissions,
      {
        productId: input.productId,
        movementType: input.movementType,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        notes: input.notes,
        branchId: input.branchId,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
