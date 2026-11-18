import { NextResponse } from 'next/server';
import { expenseInput, paymentListQuery } from '@gym/contracts';
import { listExpenses, recordExpense } from '@gym/core';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export const GET = route(
  { permission: 'finance.expense.read', source: 'query', schema: paymentListQuery },
  async ({ input, actor }) => {
    const { rows, total, totals } = await listExpenses(tenantOf(actor), actor.permissions, {
      page: input.page,
      pageSize: input.pageSize,
      fromDate: input.fromDate,
      toDate: input.toDate,
      branchId: input.branchId,
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

export const POST = route(
  { permission: 'finance.expense.manage', schema: expenseInput },
  async ({ input, actor, ipAddress }) => {
    const expense = await recordExpense(
      tenantOf(actor),
      actor.permissions,
      {
        title: input.title,
        amount: input.amount,
        taxAmount: input.taxAmount,
        expenseDate: input.spentOn,
        categoryId: input.categoryId,
        branchId: input.branchId,
        method: input.method,
        referenceNumber: input.referenceNumber,
        description: input.description,
        isRecurring: input.isRecurring,
      },
      { ipAddress },
    );
    return NextResponse.json({ data: expense }, { status: 201 });
  },
);
