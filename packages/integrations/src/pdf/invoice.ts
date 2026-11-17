import PDFDocument from 'pdfkit';
import { INVOICE_FONT_BOLD_BASE64, INVOICE_FONT_REGULAR_BASE64 } from './fonts';

/**
 * The tax invoice PDF.
 *
 * Rendered with pdfkit rather than a headless browser, deliberately: Hostinger
 * Business has no Chrome, no Docker and a 120-second request limit, so an
 * HTML-to-PDF pipeline is not an option there. pdfkit is pure JavaScript with
 * no native dependencies and renders a page of this size in milliseconds.
 *
 * The fonts are DejaVu Sans, subsetted to the characters an invoice actually
 * prints — 30 KB instead of 1.4 MB — and inlined as base64 rather than read
 * from disk. The subset exists because the rupee sign (U+20B9) is absent from
 * pdfkit's built-in Helvetica: without an embedded font every amount on a GST
 * invoice renders as a hollow box. The inlining exists because reading them
 * from disk does not survive bundling, which a production build proved by
 * failing every download with ENOENT.
 *
 * KNOWN LIMITATION, stated plainly: pdfkit does not shape complex scripts, so
 * a member whose name is stored in Devanagari or another Indic script will not
 * render correctly here. `hasUnsupportedScript` below detects that case so a
 * caller can warn rather than hand someone a broken invoice.
 */

let regular: Buffer | null = null;
let bold: Buffer | null = null;

function fonts(): { regular: Buffer; bold: Buffer } {
  // Decoded once per process, not once per invoice.
  regular ??= Buffer.from(INVOICE_FONT_REGULAR_BASE64, 'base64');
  bold ??= Buffer.from(INVOICE_FONT_BOLD_BASE64, 'base64');
  return { regular, bold };
}

/**
 * Whether any text would fall outside the embedded subset.
 *
 * The subset covers printable Latin, the rupee sign and a few typographic
 * marks. Anything else — Devanagari, Tamil, emoji — would render as a box, so
 * it is better to know before the document is handed to a member.
 */
export function hasUnsupportedScript(...values: Array<string | null | undefined>): boolean {
  const allowed = /^[ -~ ·–—‘’“”•₹…]*$/;
  return values.some((value) => value != null && !allowed.test(value));
}

export interface InvoicePdfInput {
  invoice: {
    code: string;
    status: string;
    issueDate: Date;
    dueDate: Date | null;
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    roundingAmount: string;
    total: string;
    amountPaid: string;
    amountDue: string;
    totalInWords: string;
    placeOfSupply: string | null;
    customerGstin: string | null;
    notes: string | null;
    cancelledAt: Date | null;
  };
  supplier: {
    name: string;
    legalName: string | null;
    gstin: string | null;
    panNumber: string | null;
    addressLines: string[];
    phone: string | null;
    email: string | null;
    termsText: string | null;
  };
  customer: {
    name: string;
    memberCode: string | null;
    phone: string | null;
    email: string | null;
    addressLines: string[];
  };
  lines: Array<{
    description: string;
    hsnSacCode: string | null;
    quantity: string;
    unitPrice: string;
    discountAmount: string;
    taxPercentage: string;
    taxAmount: string;
    taxableValue: string;
    lineTotal: string;
  }>;
  taxSummary: Array<{
    percentage: string;
    taxableValue: string;
    components: Array<{ label: string; percentage: string; amount: string }>;
    total: string;
  }>;
  payments: Array<{
    receiptCode: string | null;
    method: string;
    amount: string;
    receivedAt: Date;
    referenceNumber: string | null;
  }>;
}

// --------------------------------------------------------------- layout ---

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 40;
const RIGHT = PAGE.width - MARGIN;
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const ACCENT = '#2563eb';

const money = (amount: string | number): string => {
  const value = Number(amount ?? 0);
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const shortDate = (value: Date | null): string =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(value)
    : '—';

const spokenMethod = (method: string): string =>
  ({
    CASH: 'Cash',
    UPI: 'UPI',
    CARD: 'Card',
    BANK_TRANSFER: 'Bank transfer',
    CHEQUE: 'Cheque',
    RAZORPAY: 'Online',
    WALLET: 'Wallet',
    OTHER: 'Other',
  })[method] ?? method;

/**
 * Renders the invoice and resolves with the finished PDF bytes.
 *
 * Buffered rather than streamed because the document is a page or two and the
 * caller needs its length for the Content-Length header; streaming would save
 * nothing at this size.
 */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const { regular: regularFont, bold: boldFont } = fonts();

      const doc = new PDFDocument({
        size: 'A4',
        margin: MARGIN,
        info: {
          Title: `Invoice ${input.invoice.code}`,
          Author: input.supplier.legalName ?? input.supplier.name,
          Subject: 'Tax invoice',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('body', regularFont);
      doc.registerFont('strong', boldFont);

      drawHeader(doc, input);
      drawParties(doc, input);
      const afterLines = drawLines(doc, input);
      drawTotals(doc, input, afterLines);
      drawTaxSummary(doc, input);
      drawPayments(doc, input);
      drawFooter(doc, input);

      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}

type Doc = PDFKit.PDFDocument;

function drawHeader(doc: Doc, input: InvoicePdfInput): void {
  const { supplier, invoice } = input;

  doc.font('strong').fontSize(18).fillColor(INK);
  doc.text(supplier.legalName ?? supplier.name, MARGIN, MARGIN, { width: 300 });

  doc.font('body').fontSize(9).fillColor(MUTED);
  let y = doc.y + 2;
  for (const line of supplier.addressLines) {
    doc.text(line, MARGIN, y, { width: 260 });
    y = doc.y;
  }

  const contact = [supplier.phone, supplier.email].filter(Boolean).join('  ·  ');
  if (contact) {
    doc.text(contact, MARGIN, y, { width: 260 });
    y = doc.y;
  }
  if (supplier.gstin) {
    doc.font('strong').fillColor(INK).text(`GSTIN  ${supplier.gstin}`, MARGIN, y + 2);
    y = doc.y;
  }
  if (supplier.panNumber) {
    doc.font('body').fillColor(MUTED).text(`PAN  ${supplier.panNumber}`, MARGIN, y);
  }

  // --- the right-hand block ---------------------------------------------
  const cancelled = Boolean(invoice.cancelledAt);

  doc.font('strong').fontSize(15).fillColor(cancelled ? '#be123c' : ACCENT);
  doc.text(cancelled ? 'TAX INVOICE — CANCELLED' : 'TAX INVOICE', 300, MARGIN, {
    width: RIGHT - 300,
    align: 'right',
  });

  doc.font('strong').fontSize(11).fillColor(INK);
  doc.text(invoice.code, 300, doc.y + 4, { width: RIGHT - 300, align: 'right' });

  doc.font('body').fontSize(9).fillColor(MUTED);
  doc.text(`Issued  ${shortDate(invoice.issueDate)}`, 300, doc.y + 2, {
    width: RIGHT - 300,
    align: 'right',
  });
  if (invoice.dueDate) {
    doc.text(`Due  ${shortDate(invoice.dueDate)}`, 300, doc.y, {
      width: RIGHT - 300,
      align: 'right',
    });
  }
  if (invoice.placeOfSupply) {
    doc.text(`Place of supply  ${invoice.placeOfSupply}`, 300, doc.y, {
      width: RIGHT - 300,
      align: 'right',
    });
  }

  rule(doc, Math.max(doc.y, 128) + 10);
}

function drawParties(doc: Doc, input: InvoicePdfInput): void {
  const { customer, invoice } = input;
  const top = doc.y + 12;

  doc.font('body').fontSize(8).fillColor(MUTED);
  doc.text('BILLED TO', MARGIN, top);

  doc.font('strong').fontSize(11).fillColor(INK);
  doc.text(customer.name, MARGIN, doc.y + 2, { width: 260 });

  doc.font('body').fontSize(9).fillColor(MUTED);
  const identity = [customer.memberCode, customer.phone].filter(Boolean).join('  ·  ');
  if (identity) doc.text(identity, MARGIN, doc.y + 1, { width: 260 });
  for (const line of customer.addressLines) {
    doc.text(line, MARGIN, doc.y, { width: 260 });
  }
  if (invoice.customerGstin) {
    doc.font('strong').fillColor(INK).text(`GSTIN  ${invoice.customerGstin}`, MARGIN, doc.y + 1);
  }

  doc.y = Math.max(doc.y, top + 56);
}

const COLUMNS = {
  description: { x: MARGIN, width: 196 },
  hsn: { x: 244, width: 46 },
  taxable: { x: 294, width: 66 },
  rate: { x: 364, width: 38 },
  tax: { x: 406, width: 66 },
  total: { x: 476, width: RIGHT - 476 },
};

function drawLines(doc: Doc, input: InvoicePdfInput): number {
  let y = doc.y + 14;

  // header band
  doc.rect(MARGIN, y - 6, RIGHT - MARGIN, 20).fill('#f8fafc');
  doc.font('strong').fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', COLUMNS.description.x + 4, y, { width: COLUMNS.description.width });
  doc.text('HSN/SAC', COLUMNS.hsn.x, y, { width: COLUMNS.hsn.width });
  doc.text('TAXABLE', COLUMNS.taxable.x, y, { width: COLUMNS.taxable.width, align: 'right' });
  doc.text('RATE', COLUMNS.rate.x, y, { width: COLUMNS.rate.width, align: 'right' });
  doc.text('TAX', COLUMNS.tax.x, y, { width: COLUMNS.tax.width, align: 'right' });
  doc.text('AMOUNT', COLUMNS.total.x, y, { width: COLUMNS.total.width, align: 'right' });

  y += 20;

  for (const line of input.lines) {
    doc.font('body').fontSize(9).fillColor(INK);

    const descriptionHeight = doc.heightOfString(line.description, {
      width: COLUMNS.description.width,
    });

    doc.text(line.description, COLUMNS.description.x + 4, y, {
      width: COLUMNS.description.width,
    });
    doc.fillColor(MUTED).text(line.hsnSacCode ?? '—', COLUMNS.hsn.x, y, {
      width: COLUMNS.hsn.width,
    });
    doc.fillColor(INK).text(money(line.taxableValue), COLUMNS.taxable.x, y, {
      width: COLUMNS.taxable.width,
      align: 'right',
    });
    doc.fillColor(MUTED).text(`${Number(line.taxPercentage)}%`, COLUMNS.rate.x, y, {
      width: COLUMNS.rate.width,
      align: 'right',
    });
    doc.fillColor(INK).text(money(line.taxAmount), COLUMNS.tax.x, y, {
      width: COLUMNS.tax.width,
      align: 'right',
    });
    doc.font('strong').text(money(line.lineTotal), COLUMNS.total.x, y, {
      width: COLUMNS.total.width,
      align: 'right',
    });

    y += Math.max(descriptionHeight, 12) + 8;
    rule(doc, y - 4);
  }

  return y;
}

function drawTotals(doc: Doc, input: InvoicePdfInput, startY: number): void {
  const { invoice } = input;
  const labelX = 330;
  const labelWidth = 80;
  const valueX = 416;
  const valueWidth = RIGHT - valueX;

  let y = startY + 6;

  const row = (label: string, value: string, strong = false) => {
    doc.font(strong ? 'strong' : 'body').fontSize(strong ? 11 : 9);
    doc.fillColor(strong ? INK : MUTED).text(label, labelX, y, {
      width: labelWidth,
      align: 'right',
    });
    doc.fillColor(INK).text(value, valueX, y, { width: valueWidth, align: 'right' });
    y += strong ? 17 : 13;
  };

  row('Subtotal', money(invoice.subtotal));
  if (Number(invoice.discountAmount) !== 0) row('Discount', `−${money(invoice.discountAmount)}`);
  row('Tax', money(invoice.taxAmount));
  if (Number(invoice.roundingAmount) !== 0) row('Rounding', money(invoice.roundingAmount));

  doc.moveTo(labelX, y + 1).lineTo(RIGHT, y + 1).lineWidth(0.7).strokeColor(LINE).stroke();
  y += 7;
  row('Total', money(invoice.total), true);

  if (Number(invoice.amountPaid) > 0) row('Paid', `−${money(invoice.amountPaid)}`);
  if (Number(invoice.amountDue) > 0) {
    doc.font('strong').fontSize(10).fillColor('#b45309');
    doc.text('Balance due', labelX, y, { width: labelWidth, align: 'right' });
    doc.text(money(invoice.amountDue), valueX, y, { width: valueWidth, align: 'right' });
    y += 15;
  }

  // The amount in words, which an Indian invoice carries.
  doc.font('body').fontSize(8).fillColor(MUTED);
  doc.text('Amount in words', MARGIN, startY + 6, { width: 280 });
  doc.font('strong').fontSize(9).fillColor(INK);
  doc.text(invoice.totalInWords, MARGIN, doc.y + 1, { width: 280 });

  doc.y = Math.max(y, doc.y) + 10;
}

function drawTaxSummary(doc: Doc, input: InvoicePdfInput): void {
  if (input.taxSummary.length === 0) return;

  let y = doc.y + 6;

  doc.font('strong').fontSize(8).fillColor(MUTED);
  doc.text('TAX SUMMARY', MARGIN, y);
  y = doc.y + 4;

  doc.rect(MARGIN, y - 4, RIGHT - MARGIN, 18).fill('#f8fafc');
  doc.font('strong').fontSize(8).fillColor(MUTED);
  doc.text('TAXABLE VALUE', MARGIN + 4, y, { width: 110 });

  let headerX = 160;
  const componentCount = Math.max(...input.taxSummary.map((entry) => entry.components.length), 1);
  const componentWidth = Math.min(110, (RIGHT - 160 - 80) / componentCount);

  for (const component of input.taxSummary[0]!.components) {
    doc.text(component.label, headerX, y, { width: componentWidth, align: 'right' });
    headerX += componentWidth;
  }
  doc.text('TOTAL TAX', RIGHT - 80, y, { width: 80, align: 'right' });

  y += 18;

  for (const entry of input.taxSummary) {
    // Aligned with the component AMOUNTS, not the percentages above them,
    // so the eye reads one row of money rather than a staircase.
    doc.font('body').fontSize(9).fillColor(INK);
    doc.text(money(entry.taxableValue), MARGIN + 4, y + 9, { width: 110 });

    let x = 160;
    for (const component of entry.components) {
      doc.fillColor(MUTED).fontSize(8);
      doc.text(`${component.percentage}%`, x, y, { width: componentWidth, align: 'right' });
      doc.fillColor(INK).fontSize(9);
      doc.text(money(component.amount), x, y + 9, { width: componentWidth, align: 'right' });
      x += componentWidth;
    }

    doc.font('strong').fontSize(9).fillColor(INK);
    doc.text(money(entry.total), RIGHT - 80, y + 9, { width: 80, align: 'right' });

    y += 26;
    rule(doc, y - 6);
  }

  doc.y = y;
}

function drawPayments(doc: Doc, input: InvoicePdfInput): void {
  if (input.payments.length === 0) return;

  let y = doc.y + 8;
  doc.font('strong').fontSize(8).fillColor(MUTED);
  doc.text('PAYMENTS RECEIVED', MARGIN, y);
  y = doc.y + 4;

  for (const payment of input.payments) {
    doc.font('body').fontSize(9).fillColor(MUTED);
    const reference = payment.referenceNumber ? `  ·  ${payment.referenceNumber}` : '';
    doc.text(
      `${shortDate(payment.receivedAt)}  ·  ${spokenMethod(payment.method)}${reference}`,
      MARGIN,
      y,
      { width: 380 },
    );
    doc.fillColor(INK).text(payment.receiptCode ?? '', 280, y, { width: 120, align: 'right' });
    doc.font('strong').text(money(payment.amount), RIGHT - 90, y, {
      width: 90,
      align: 'right',
    });
    y += 14;
  }

  doc.y = y;
}

function drawFooter(doc: Doc, input: InvoicePdfInput): void {
  const { supplier, invoice } = input;

  // Pin the footer to the bottom of the page rather than letting it float up
  // under a short invoice.
  const y = Math.max(doc.y + 16, PAGE.height - MARGIN - 82);

  rule(doc, y);

  doc.font('body').fontSize(8).fillColor(MUTED);
  let textY = y + 8;

  if (invoice.notes) {
    doc.text(invoice.notes, MARGIN, textY, { width: 330 });
    textY = doc.y + 4;
  }
  if (supplier.termsText) {
    doc.text(supplier.termsText, MARGIN, textY, { width: 330 });
    textY = doc.y + 4;
  }

  doc.text(
    'This is a computer-generated invoice and is valid without a signature.',
    MARGIN,
    Math.max(textY, PAGE.height - MARGIN - 22),
    { width: 330 },
  );

  doc.font('strong').fontSize(9).fillColor(INK);
  doc.text(`For ${supplier.legalName ?? supplier.name}`, 360, y + 10, {
    width: RIGHT - 360,
    align: 'right',
  });
  doc.font('body').fontSize(8).fillColor(MUTED);
  doc.text('Authorised signatory', 360, PAGE.height - MARGIN - 22, {
    width: RIGHT - 360,
    align: 'right',
  });
}

function rule(doc: Doc, y: number): void {
  doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.y = y;
}
