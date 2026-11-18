import { NextResponse } from 'next/server';
import { getReceiptDocument } from '@gym/core';
import { renderReceiptPdf } from '@gym/integrations';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The payment receipt as a PDF.
 *
 * Rendered on demand, like the invoice: the figures are already immutable,
 * so a stored file could only go stale or disagree with them.
 */
export const GET = route({ permission: 'finance.payment.read' }, async ({ actor, params }) => {
  const document = await getReceiptDocument(tenantOf(actor), actor.permissions, params.id!);
  const pdf = await renderReceiptPdf(document);

  const filename = `${document.receipt.code.replace(/[/\\]/g, '-')}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
      'content-disposition': `inline; filename="${filename}"`,
      // Someone's payment record: never held by a shared cache.
      'cache-control': 'private, no-store',
    },
  });
});
