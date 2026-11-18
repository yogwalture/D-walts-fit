import PDFDocument from 'pdfkit';
import { INVOICE_FONT_BOLD_BASE64, INVOICE_FONT_REGULAR_BASE64 } from './fonts';

/**
 * The payment receipt.
 *
 * Half a page, not a full one — this is the slip a member folds into their
 * wallet, and it has one job: prove that this person handed over this amount
 * on this day, by this means, to this gym. Everything else is noise on it.
 *
 * Same engine and same inlined fonts as the invoice, for the same reasons:
 * Hostinger has no Chrome, and pdfkit's built-in Helvetica has no rupee sign.
 */

let regular: Buffer | null = null;
let bold: Buffer | null = null;

function fonts(): { regular: Buffer; bold: Buffer } {
  regular ??= Buffer.from(INVOICE_FONT_REGULAR_BASE64, 'base64');
  bold ??= Buffer.from(INVOICE_FONT_BOLD_BASE64, 'base64');
  return { regular, bold };
}

export interface ReceiptPdfInput {
  receipt: {
    code: string;
    receivedAt: Date;
    amount: string;
    amountInWords: string;
    method: string;
    referenceNumber: string | null;
    status: string;
    notes: string | null;
  };
  supplier: {
    name: string;
    legalName: string | null;
    gstin: string | null;
    addressLines: string[];
    phone: string | null;
    email: string | null;
  };
  payer: { name: string; memberCode: string | null; phone: string | null };
  towards: {
    invoiceCode: string | null;
    invoiceTotal: string | null;
    invoiceDue: string | null;
    planName: string | null;
    periodFrom: Date | null;
    periodTo: Date | null;
  };
  collectedBy: string | null;
}

const MARGIN = 40;
const WIDTH = 595.28;
const RIGHT = WIDTH - MARGIN;
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const GOOD = '#047857';

const money = (value: string | number): string =>
  `₹${Number(value ?? 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const dateTime = (value: Date): string =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(value);

const shortDate = (value: Date): string =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);

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

export function renderReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const { regular: regularFont, bold: boldFont } = fonts();
      const refunded = input.receipt.status === 'REFUNDED';
      const partlyRefunded = input.receipt.status === 'PARTIALLY_REFUNDED';

      const doc = new PDFDocument({
        // Half of A4: a receipt, not a document.
        size: [WIDTH, 420],
        margin: MARGIN,
        info: {
          Title: `Receipt ${input.receipt.code}`,
          Author: input.supplier.legalName ?? input.supplier.name,
          Subject: 'Payment receipt',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('body', regularFont);
      doc.registerFont('strong', boldFont);

      // --- who ------------------------------------------------------------
      doc.font('strong').fontSize(15).fillColor(INK);
      doc.text(input.supplier.legalName ?? input.supplier.name, MARGIN, MARGIN, { width: 300 });

      doc.font('body').fontSize(8).fillColor(MUTED);
      let y = doc.y + 1;
      for (const line of input.supplier.addressLines.slice(0, 3)) {
        doc.text(line, MARGIN, y, { width: 280 });
        y = doc.y;
      }
      const contact = [input.supplier.phone, input.supplier.email].filter(Boolean).join('  ·  ');
      if (contact) doc.text(contact, MARGIN, y, { width: 280 });
      if (input.supplier.gstin) {
        doc.text(`GSTIN  ${input.supplier.gstin}`, MARGIN, doc.y, { width: 280 });
      }

      doc.font('strong').fontSize(13).fillColor(refunded ? '#be123c' : GOOD);
      doc.text(refunded ? 'RECEIPT — REFUNDED' : 'PAYMENT RECEIPT', 300, MARGIN, {
        width: RIGHT - 300,
        align: 'right',
      });
      doc.font('strong').fontSize(10).fillColor(INK);
      doc.text(input.receipt.code, 300, doc.y + 3, { width: RIGHT - 300, align: 'right' });
      doc.font('body').fontSize(8).fillColor(MUTED);
      doc.text(dateTime(input.receipt.receivedAt), 300, doc.y + 1, {
        width: RIGHT - 300,
        align: 'right',
      });

      // Follow the content rather than a fixed floor: a gym that has not
      // filled in its address should not get a band of white space where the
      // address would have been.
      y = Math.max(doc.y, 76) + 12;
      doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke();

      // --- the amount, which is the point of the page ---------------------
      y += 14;
      doc.font('body').fontSize(8).fillColor(MUTED);
      doc.text('RECEIVED FROM', MARGIN, y);
      doc.font('strong').fontSize(12).fillColor(INK);
      doc.text(input.payer.name, MARGIN, doc.y + 1, { width: 260 });

      doc.font('body').fontSize(8).fillColor(MUTED);
      const identity = [input.payer.memberCode, input.payer.phone].filter(Boolean).join('  ·  ');
      if (identity) doc.text(identity, MARGIN, doc.y + 1, { width: 260 });

      doc.font('body').fontSize(8).fillColor(MUTED);
      doc.text('AMOUNT', 320, y, { width: RIGHT - 320, align: 'right' });
      doc.font('strong').fontSize(22).fillColor(refunded ? '#be123c' : GOOD);
      doc.text(money(input.receipt.amount), 300, y + 10, {
        width: RIGHT - 300,
        align: 'right',
      });

      y = Math.max(doc.y, y + 50) + 8;

      doc.font('body').fontSize(8).fillColor(MUTED);
      doc.text('In words', MARGIN, y);
      doc.font('strong').fontSize(9).fillColor(INK);
      doc.text(input.receipt.amountInWords, MARGIN, doc.y + 1, { width: RIGHT - MARGIN });

      y = doc.y + 12;
      doc.moveTo(MARGIN, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(LINE).stroke();

      // --- how and what for ------------------------------------------------
      y += 12;
      const pairs: Array<[string, string]> = [
        [
          'Paid by',
          spokenMethod(input.receipt.method) +
            (input.receipt.referenceNumber ? `  ·  ${input.receipt.referenceNumber}` : ''),
        ],
      ];

      if (input.towards.planName) {
        const period =
          input.towards.periodFrom && input.towards.periodTo
            ? `  ·  ${shortDate(input.towards.periodFrom)} to ${shortDate(input.towards.periodTo)}`
            : '';
        pairs.push(['Towards', `${input.towards.planName}${period}`]);
      }

      if (input.towards.invoiceCode) {
        const due = input.towards.invoiceDue;
        pairs.push([
          'Against invoice',
          `${input.towards.invoiceCode}${
            due && Number(due) > 0 ? `  ·  ${money(due)} still due` : '  ·  settled in full'
          }`,
        ]);
      }

      if (input.collectedBy) pairs.push(['Received by', input.collectedBy]);
      if (partlyRefunded) pairs.push(['Note', 'Part of this payment has been refunded']);
      if (input.receipt.notes) pairs.push(['Note', input.receipt.notes]);

      for (const [label, value] of pairs) {
        doc.font('body').fontSize(8).fillColor(MUTED);
        doc.text(label, MARGIN, y, { width: 90 });
        doc.font('body').fontSize(9).fillColor(INK);
        doc.text(value, MARGIN + 96, y - 1, { width: RIGHT - MARGIN - 96 });
        y = Math.max(doc.y, y + 12) + 3;
      }

      // --- footer -----------------------------------------------------------
      const footerY = 420 - MARGIN - 26;
      doc.moveTo(MARGIN, footerY).lineTo(RIGHT, footerY).lineWidth(0.5).strokeColor(LINE).stroke();

      doc.font('body').fontSize(7.5).fillColor(MUTED);
      doc.text(
        'Computer-generated receipt, valid without a signature. Please keep it for your records.',
        MARGIN,
        footerY + 8,
        { width: 330 },
      );
      doc.font('strong').fontSize(8).fillColor(INK);
      doc.text(`For ${input.supplier.legalName ?? input.supplier.name}`, 340, footerY + 8, {
        width: RIGHT - 340,
        align: 'right',
      });

      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}
