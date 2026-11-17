import { NextResponse } from 'next/server';
import { getInvoiceDocument } from '@gym/core';
import { renderInvoicePdf } from '@gym/integrations';
import { route } from '@/lib/handler';
import { tenantOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/**
 * The tax invoice as a PDF.
 *
 * Rendered on demand rather than stored: the figures are already immutable in
 * the database, so a cached file could only ever go stale or disagree with
 * them. It also means no file storage to configure before a gym can hand a
 * member their invoice.
 *
 * Served inline so it opens in the browser's viewer, with a filename that is
 * the invoice number — a member saving three of these should not end up with
 * three files called `invoice.pdf`.
 */
export const GET = route({ permission: 'finance.invoice.read' }, async ({ actor, params }) => {
  const document = await getInvoiceDocument(tenantOf(actor), actor.permissions, params.id!);
  const pdf = await renderInvoicePdf(document);

  const filename = `${document.invoice.code.replace(/[/\\]/g, '-')}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
      'content-disposition': `inline; filename="${filename}"`,
      // A tax document is per-member and must never be held by a shared cache.
      'cache-control': 'private, no-store',
    },
  });
});
