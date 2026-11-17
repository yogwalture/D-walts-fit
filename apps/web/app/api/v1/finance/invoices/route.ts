import { NextResponse } from 'next/server';
import { invoiceListQuery } from '@gym/contracts';
import { listInvoices } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'finance.invoice.read', source: 'query', schema: invoiceListQuery },
  async ({ input, actor }) => {
    const { rows, total, totals } = await listInvoices(tenantOf(actor), actor.permissions, {
      page: input.page,
      pageSize: input.pageSize,
      status: input.status,
      fromDate: input.fromDate,
      toDate: input.toDate,
      memberId: input.memberId,
      search: input.search,
    });

    return NextResponse.json(
      {
        data: rows,
        meta: {
          page: input.page,
          pageSize: input.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / input.pageSize)),
          totals,
        },
      },
      { status: 200 },
    );
  },
);
