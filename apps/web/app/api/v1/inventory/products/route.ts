import { NextResponse } from 'next/server';
import { productInput, productListQuery } from '@gym/contracts';
import { createProduct, listProducts } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'inventory.product.read', source: 'query', schema: productListQuery },
  async ({ input, actor }) => {
    const rows = await listProducts(tenantOf(actor), actor.permissions, {
      search: input.search,
      category: input.category,
      lowOnly: input.lowOnly,
      includeInactive: input.includeInactive,
    });
    return NextResponse.json({ data: rows });
  },
);

export const POST = route(
  { permission: 'inventory.product.manage', schema: productInput },
  async ({ input, actor, ipAddress }) => {
    const created = await createProduct(
      tenantOf(actor),
      actor.permissions,
      {
        name: input.name,
        category: input.category,
        sku: input.sku,
        barcode: input.barcode,
        unit: input.unit,
        purchasePrice: input.purchasePrice,
        sellingPrice: input.sellingPrice,
        taxRateId: input.taxRateId,
        reorderLevel: input.reorderLevel,
        openingStock: input.openingStock,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: created }, { status: 201 });
  },
);
