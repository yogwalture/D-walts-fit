import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { formatRupees, toPaise } from '../shared/money';

/**
 * Invoices.
 *
 * A tax invoice is a legal document, not a receipt with nicer styling. Under
 * Indian GST it must carry the supplier's GSTIN and address, the place of
 * supply, an HSN/SAC code, the taxable value and each tax component shown
 * separately, and a serial number from an unbroken series.
 *
 * So the figures here are never recomputed for display. They are read back
 * exactly as they were written at the moment of sale: if a plan's price or
 * tax rate changes next March, an invoice issued today must still say what
 * it said today.
 */

/**
 * Money, as a canonical two-decimal string.
 *
 * Prisma's Decimal renders 14000.00 as "14000", which is the same number and
 * the wrong document: an invoice says ₹14,000.00. Every money field crossing
 * this boundary goes through here, so a consumer never has to guess whether
 * it got two decimals this time.
 */
const amount = (value: unknown): string => Number(value ?? 0).toFixed(2);

export interface InvoiceContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

export interface InvoiceListRow {
  id: string;
  invoiceCode: string;
  status: string;
  issueDate: Date;
  dueDate: Date | null;
  total: string;
  amountPaid: string;
  amountDue: string;
  memberId: string | null;
  memberName: string | null;
  memberCode: string | null;
}

export async function listInvoices(
  ctx: InvoiceContext,
  permissions: ResolvedPermissions,
  options: {
    page?: number;
    pageSize?: number;
    status?: string;
    fromDate?: string;
    toDate?: string;
    memberId?: string;
    search?: string;
  } = {},
): Promise<{ rows: InvoiceListRow[]; total: number; totals: { billed: string; due: string } }> {
  requirePermission(permissions, 'finance.invoice.read');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 25, 100);

  return withTenant(ctx, async (tx) => {
    const where: Record<string, unknown> = {
      ...(options.status && options.status !== 'all' ? { status: options.status } : {}),
      ...(options.memberId ? { memberId: options.memberId } : {}),
      ...(options.fromDate || options.toDate
        ? {
            issueDate: {
              ...(options.fromDate ? { gte: new Date(`${options.fromDate}T00:00:00Z`) } : {}),
              ...(options.toDate ? { lte: new Date(`${options.toDate}T00:00:00Z`) } : {}),
            },
          }
        : {}),
      ...(options.search
        ? {
            OR: [
              { invoiceCode: { contains: options.search, mode: 'insensitive' } },
              { member: { firstName: { contains: options.search, mode: 'insensitive' } } },
              { member: { lastName: { contains: options.search, mode: 'insensitive' } } },
              { member: { memberCode: { contains: options.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      tx.invoice.findMany({
        where,
        orderBy: [{ issueDate: 'desc' }, { invoiceNumber: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          invoiceCode: true,
          status: true,
          issueDate: true,
          dueDate: true,
          total: true,
          amountPaid: true,
          amountDue: true,
          member: {
            select: { id: true, memberCode: true, firstName: true, lastName: true },
          },
        },
      }),
      tx.invoice.count({ where }),
      tx.invoice.aggregate({ where, _sum: { total: true, amountDue: true } }),
    ]);

    return {
      total,
      totals: {
        billed: amount(sums._sum?.total),
        due: amount(sums._sum?.amountDue),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows: rows.map((row: any) => ({
        id: row.id,
        invoiceCode: row.invoiceCode,
        status: row.status,
        issueDate: row.issueDate,
        dueDate: row.dueDate,
        total: amount(row.total),
        amountPaid: amount(row.amountPaid),
        amountDue: amount(row.amountDue),
        memberId: row.member?.id ?? null,
        memberName: row.member
          ? [row.member.firstName, row.member.lastName].filter(Boolean).join(' ')
          : null,
        memberCode: row.member?.memberCode ?? null,
      })),
    };
  });
}

// ------------------------------------------------------------- rendering ---

export interface InvoiceDocument {
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
    /** The value tax is charged on — what a GST return calls taxable value. */
    taxableValue: string;
    lineTotal: string;
  }>;
  /** One row per distinct rate, as a GST return summarises it. */
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

/**
 * Everything a tax invoice must show, read in one pass.
 *
 * Used by both the PDF renderer and the on-screen invoice, so the two cannot
 * disagree about what the document says.
 */
export async function getInvoiceDocument(
  ctx: InvoiceContext,
  permissions: ResolvedPermissions,
  invoiceId: string,
): Promise<InvoiceDocument> {
  requirePermission(permissions, 'finance.invoice.read');

  return withTenant(ctx, async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        invoiceCode: true,
        status: true,
        issueDate: true,
        dueDate: true,
        subtotal: true,
        discountAmount: true,
        taxAmount: true,
        roundingAmount: true,
        total: true,
        amountPaid: true,
        amountDue: true,
        placeOfSupply: true,
        customerGstin: true,
        notes: true,
        cancelledAt: true,
        organization: { select: { name: true, legalName: true } },
        branch: {
          select: {
            name: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
            phone: true,
            email: true,
          },
        },
        member: {
          select: {
            memberCode: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            postalCode: true,
          },
        },
        lines: {
          orderBy: { displayOrder: 'asc' },
          select: {
            description: true,
            hsnSacCode: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            taxPercentage: true,
            taxAmount: true,
            lineTotal: true,
            taxRate: { select: { name: true, components: true } },
          },
        },
        payments: {
          where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
          orderBy: { receivedAt: 'asc' },
          select: {
            receiptCode: true,
            method: true,
            amount: true,
            receivedAt: true,
            referenceNumber: true,
          },
        },
      },
    });

    if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found.');

    const settings = await tx.orgSetting.findFirst({
      select: {
        gstin: true,
        panNumber: true,
        legalAddress: true,
        contactPhone: true,
        contactEmail: true,
        invoiceTermsText: true,
      },
    });

    // The branch is the place the service was supplied from, so its address
    // is the supplier address on the invoice. The org's registered address is
    // the fallback when a branch has none recorded.
    const branch = invoice.branch;
    const legal = (settings?.legalAddress ?? null) as Record<string, string> | null;

    const supplierAddress = [
      branch?.addressLine1 ?? legal?.line1,
      branch?.addressLine2 ?? legal?.line2,
      [branch?.city ?? legal?.city, branch?.state ?? legal?.state].filter(Boolean).join(', '),
      branch?.postalCode ?? legal?.postalCode,
    ].filter((part): part is string => Boolean(part && part.trim()));

    const customerAddress = [
      invoice.member?.addressLine1,
      invoice.member?.addressLine2,
      [invoice.member?.city, invoice.member?.state].filter(Boolean).join(', '),
      invoice.member?.postalCode,
    ].filter((part): part is string => Boolean(part && part.trim()));

    // --- lines, with the taxable value spelled out ------------------------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = invoice.lines.map((line: any) => {
      const lineTotal = toPaise(line.lineTotal.toString());
      const tax = toPaise(line.taxAmount.toString());
      return {
        description: line.description,
        hsnSacCode: line.hsnSacCode,
        quantity: line.quantity.toString(),
        unitPrice: amount(line.unitPrice),
        discountAmount: amount(line.discountAmount),
        // Not an amount: "18" reads better than "18.00" next to a % sign.
        taxPercentage: Number(line.taxPercentage).toString(),
        taxAmount: amount(line.taxAmount),
        taxableValue: ((lineTotal - tax) / 100).toFixed(2),
        lineTotal: amount(line.lineTotal),
      };
    });

    // --- the tax summary, grouped by rate ---------------------------------
    const byRate = new Map<
      string,
      { taxablePaise: number; taxPaise: number; components: Record<string, number> }
    >();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const line of invoice.lines as any[]) {
      const percentage = Number(line.taxPercentage).toString();
      if (Number(percentage) === 0) continue;

      const lineTotal = toPaise(line.lineTotal.toString());
      const tax = toPaise(line.taxAmount.toString());

      const entry = byRate.get(percentage) ?? {
        taxablePaise: 0,
        taxPaise: 0,
        components: (line.taxRate?.components ?? {}) as Record<string, number>,
      };
      entry.taxablePaise += lineTotal - tax;
      entry.taxPaise += tax;
      byRate.set(percentage, entry);
    }

    const taxSummary = [...byRate.entries()].map(([percentage, entry]) => {
      const names = Object.keys(entry.components);
      // Split the rate's own total across its components, giving the largest
      // the remainder so the parts always add back to the tax charged.
      const split = names.map((name) => ({
        label: name.toUpperCase(),
        percentage: String(entry.components[name]),
        paise: Math.round((entry.taxPaise * Number(entry.components[name])) / Number(percentage)),
      }));

      const drift = entry.taxPaise - split.reduce((sum, part) => sum + part.paise, 0);
      if (split.length > 0 && drift !== 0) {
        const largest = split.reduce((a, b) => (b.paise > a.paise ? b : a));
        largest.paise += drift;
      }

      return {
        percentage,
        taxableValue: (entry.taxablePaise / 100).toFixed(2),
        components: split.map((part) => ({
          label: part.label,
          percentage: part.percentage,
          amount: (part.paise / 100).toFixed(2),
        })),
        total: (entry.taxPaise / 100).toFixed(2),
      };
    });

    return {
      invoice: {
        code: invoice.invoiceCode,
        status: invoice.status,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        subtotal: amount(invoice.subtotal),
        discountAmount: amount(invoice.discountAmount),
        taxAmount: amount(invoice.taxAmount),
        roundingAmount: amount(invoice.roundingAmount),
        total: amount(invoice.total),
        amountPaid: amount(invoice.amountPaid),
        amountDue: amount(invoice.amountDue),
        totalInWords: rupeesInWords(amount(invoice.total)),
        // Place of supply decides CGST+SGST versus IGST, so GST requires it
        // on the face of the invoice. Taken from the invoice when it was
        // stamped there, otherwise resolved from the branch the service was
        // supplied from, otherwise the gym's registered state. Null means the
        // gym has not recorded a state anywhere — a real gap to fix in
        // settings, not something to invent a value for.
        placeOfSupply: invoice.placeOfSupply ?? branch?.state ?? legal?.state ?? null,
        customerGstin: invoice.customerGstin,
        notes: invoice.notes,
        cancelledAt: invoice.cancelledAt,
      },
      supplier: {
        name: invoice.organization.name,
        legalName: invoice.organization.legalName,
        gstin: settings?.gstin ?? null,
        panNumber: settings?.panNumber ?? null,
        addressLines: supplierAddress,
        phone: branch?.phone ?? settings?.contactPhone ?? null,
        email: branch?.email ?? settings?.contactEmail ?? null,
        termsText: settings?.invoiceTermsText ?? null,
      },
      customer: {
        name: invoice.member
          ? [invoice.member.firstName, invoice.member.lastName].filter(Boolean).join(' ')
          : 'Walk-in',
        memberCode: invoice.member?.memberCode ?? null,
        phone: invoice.member?.phone ?? null,
        email: invoice.member?.email ?? null,
        addressLines: customerAddress,
      },
      lines,
      taxSummary,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payments: invoice.payments.map((payment: any) => ({
        receiptCode: payment.receiptCode,
        method: payment.method,
        amount: amount(payment.amount),
        receivedAt: payment.receivedAt,
        referenceNumber: payment.referenceNumber,
      })),
    };
  });
}

// ------------------------------------------------------------ in words ---

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function underHundred(value: number): string {
  if (value < 20) return ONES[value]!;
  const tens = TENS[Math.floor(value / 10)]!;
  const ones = ONES[value % 10]!;
  return ones ? `${tens} ${ones}` : tens;
}

function underThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(underHundred(rest));
  return parts.join(' ');
}

/**
 * "One Thousand Five Hundred Rupees Only", in the Indian system.
 *
 * Invoices in India carry the amount in words, and the grouping is lakh and
 * crore — not million — so this cannot be a generic number-to-words library.
 */
export function rupeesInWords(amount: string | number): string {
  const paise = toPaise(typeof amount === 'number' ? amount : amount);
  const negative = paise < 0;
  const absolute = Math.abs(paise);

  const rupees = Math.floor(absolute / 100);
  const fraction = absolute % 100;

  const groups: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const remainder = rupees % 1000;

  if (crore) groups.push(`${underThousand(crore)} Crore`);
  if (lakh) groups.push(`${underHundred(lakh)} Lakh`);
  if (thousand) groups.push(`${underHundred(thousand)} Thousand`);
  if (remainder) groups.push(underThousand(remainder));

  const whole = groups.length > 0 ? groups.join(' ') : 'Zero';
  const words = fraction
    ? `${whole} Rupees and ${underHundred(fraction)} Paise Only`
    : `${whole} Rupees Only`;

  return negative ? `Minus ${words}` : words;
}

/** For the on-screen invoice; the PDF formats its own. */
export function displayAmount(amount: string): string {
  return formatRupees(toPaise(amount));
}
