/**
 * Money and tax.
 *
 * Every amount is handled in paise — integers — and only converted to a
 * decimal string at the edges. Floating point is never used for money: it
 * cannot represent ₹0.10 exactly, and a gym that takes three hundred
 * payments a month will notice.
 */

export type Paise = number;

export function toPaise(amount: string | number): Paise {
  const value = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const [rupees, fraction = ''] = value.split('.');
  const sign = rupees!.startsWith('-') ? -1 : 1;
  const whole = Math.abs(Number.parseInt(rupees!, 10) || 0);
  const paise = Number.parseInt(fraction.padEnd(2, '0').slice(0, 2), 10) || 0;
  return sign * (whole * 100 + paise);
}

export function toRupees(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(Math.round(paise));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function formatRupees(paise: Paise): string {
  return `₹${Number(toRupees(paise)).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ------------------------------------------------------------------ tax ---

export interface TaxBreakdown {
  /** Amount before tax. */
  taxable: Paise;
  /** Total tax. */
  tax: Paise;
  /** Tax inclusive total — what the member actually pays. */
  total: Paise;
  /** Component split, e.g. { cgst: 11186, sgst: 11186 }. */
  components: Record<string, Paise>;
  ratePercent: string;
}

export interface TaxRateInput {
  /** Prisma hands back a Decimal; a plain string or number is fine too. */
  percentage: string | number | { toString(): string };
  /**
   * e.g. { cgst: 9, sgst: 9 } — must sum to `percentage`.
   * Typed loosely because it arrives as a JSON column.
   */
  components?: Record<string, unknown> | unknown | null;
}

/**
 * Splits an amount into taxable value and tax.
 *
 * Indian gyms almost always quote a tax-INCLUSIVE price: the board says
 * ₹1,500 and ₹1,500 is what the member hands over. Backing the tax out of
 * that is the common case, and getting it the wrong way round overcharges
 * every member by the tax rate.
 *
 * Rounding: components are rounded individually and the largest absorbs the
 * remainder, so the parts always sum to the whole. A one-paisa discrepancy
 * between CGST + SGST and the total is the kind of thing that fails a GST
 * return.
 */
export function splitTax(
  amount: Paise,
  rate: TaxRateInput | null | undefined,
  options: { inclusive?: boolean } = {},
): TaxBreakdown {
  const inclusive = options.inclusive ?? true;
  const percent = Number(rate?.percentage ?? 0);

  if (!rate || percent === 0) {
    return {
      taxable: amount,
      tax: 0,
      total: amount,
      components: {},
      ratePercent: '0',
    };
  }

  let taxable: Paise;
  let total: Paise;

  if (inclusive) {
    total = amount;
    taxable = Math.round((amount * 100) / (100 + percent));
  } else {
    taxable = amount;
    total = taxable + Math.round((taxable * percent) / 100);
  }

  const tax = total - taxable;

  const split = (rate.components ?? {}) as Record<string, number>;
  const names = Object.keys(split);

  if (names.length === 0) {
    return { taxable, tax, total, components: { tax }, ratePercent: String(percent) };
  }

  const components: Record<string, Paise> = {};
  let allocated = 0;
  let largest = names[0]!;

  for (const name of names) {
    const componentPercent = Number(split[name] ?? 0);
    const value = Math.round((taxable * componentPercent) / 100);
    components[name] = value;
    allocated += value;
    if (componentPercent > Number(split[largest] ?? 0)) largest = name;
  }

  // The largest component absorbs the rounding remainder, so the parts
  // always sum to the tax exactly.
  components[largest] = (components[largest] ?? 0) + (tax - allocated);

  return { taxable, tax, total, components, ratePercent: String(percent) };
}

export type DiscountKind = 'PERCENTAGE' | 'FIXED_AMOUNT';

/**
 * Applies a discount, never below zero and never above any stated cap.
 * Returns the discount itself rather than the discounted amount, because
 * the invoice has to show the line.
 */
export function discountAmount(
  base: Paise,
  kind: DiscountKind,
  value: string | number,
  maxDiscount?: string | number | null,
): Paise {
  const raw =
    kind === 'PERCENTAGE'
      ? Math.round((base * Number(value)) / 100)
      : toPaise(value);

  const capped = maxDiscount ? Math.min(raw, toPaise(maxDiscount)) : raw;
  return Math.max(0, Math.min(capped, base));
}

/** Rounds a total to the nearest rupee, returning the adjustment separately. */
export function roundToRupee(total: Paise): { rounded: Paise; adjustment: Paise } {
  const rounded = Math.round(total / 100) * 100;
  return { rounded, adjustment: rounded - total };
}
