import { financialYear } from './dates';

/**
 * Gapless numbering.
 *
 * Invoice numbers must be sequential and without gaps per organization and
 * financial year — that is a GST requirement, not a preference. Two
 * receptionists taking payments at the same moment must not produce two
 * invoices numbered 47.
 *
 * The guarantee comes from `UPDATE ... RETURNING` on a single counter row,
 * which takes a row lock for the duration of the transaction. The second
 * caller waits, reads the incremented value, and gets 48.
 *
 * This only holds if the caller is inside the SAME transaction that writes
 * the invoice. Allocating a number and then committing the invoice later
 * leaves a gap when the later step fails, so both take one transaction.
 */

export interface AllocatedNumber {
  number: number;
  /** The rendered code, e.g. INV/2026-27/00048 */
  code: string;
  series: string;
  financialYear: string;
}

export async function allocateInvoiceNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  input: {
    organizationId: string;
    series?: string;
    prefix?: string;
    at?: Date;
  },
): Promise<AllocatedNumber> {
  const series = input.series ?? 'INV';
  const year = financialYear(input.at ?? new Date());
  const prefix = input.prefix ?? series;

  // Create the counter on first use, then take it. ON CONFLICT DO NOTHING
  // rather than a read-then-write, so two first payments cannot race.
  await tx.$executeRaw`
    INSERT INTO invoice_sequences ("id", "organizationId", "series", "financialYear", "prefix", "nextNumber", "padding", "updatedAt")
    VALUES (gen_random_uuid(), ${input.organizationId}::uuid, ${series}, ${year}, ${prefix}, 1, 5, now())
    ON CONFLICT ("organizationId", "series", "financialYear") DO NOTHING`;

  const rows = await tx.$queryRaw<Array<{ nextNumber: number; padding: number; prefix: string }>>`
    UPDATE invoice_sequences
       SET "nextNumber" = "nextNumber" + 1, "updatedAt" = now()
     WHERE "organizationId" = ${input.organizationId}::uuid
       AND "series" = ${series}
       AND "financialYear" = ${year}
    RETURNING "nextNumber" - 1 AS "nextNumber", "padding", "prefix"`;

  const row = rows[0];
  if (!row) {
    throw new Error(`Could not allocate a ${series} number for ${year}`);
  }

  return {
    number: row.nextNumber,
    code: `${row.prefix}/${year}/${String(row.nextNumber).padStart(row.padding, '0')}`,
    series,
    financialYear: year,
  };
}

/**
 * Member codes.
 *
 * Gapless is not required here — a member code is an identifier, not a tax
 * document — but it must be unique per gym and readable at a desk. Same
 * locking approach, on org_settings.
 */
export async function allocateMemberCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  organizationId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ memberCodeNextNumber: number; memberCodePrefix: string }>>`
    UPDATE org_settings
       SET "memberCodeNextNumber" = "memberCodeNextNumber" + 1, "updatedAt" = now()
     WHERE "organizationId" = ${organizationId}::uuid
    RETURNING "memberCodeNextNumber" - 1 AS "memberCodeNextNumber", "memberCodePrefix"`;

  const row = rows[0];
  if (!row) {
    throw new Error('Organization settings are missing; cannot allocate a member code.');
  }

  return `${row.memberCodePrefix}${String(row.memberCodeNextNumber).padStart(5, '0')}`;
}

/** Receipt numbers, same guarantee, separate series from invoices. */
export async function allocateReceiptNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  organizationId: string,
  at?: Date,
): Promise<AllocatedNumber> {
  return allocateInvoiceNumber(tx, {
    organizationId,
    series: 'RCP',
    prefix: 'RCP',
    at,
  });
}
