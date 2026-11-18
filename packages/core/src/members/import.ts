import { withTenant } from '@gym/db';
import { AppError } from '../errors';
import { writeAudit } from '../audit/log';
import { requirePermission, type ResolvedPermissions } from '../rbac/engine';
import { allocateMemberCode } from '../shared/sequences';
import { startOfDay } from '../shared/dates';
import { readSpreadsheet, SpreadsheetError, type SheetTable } from '../shared/spreadsheet';

/**
 * Bringing a gym's existing members in from a spreadsheet.
 *
 * This is the step that decides whether a gym can switch at all: nobody
 * retypes four hundred members, and a gym that cannot bring its list across
 * does not become a customer.
 *
 * So the design is built around the file being a mess, because it will be.
 * Headers are whatever the previous software exported. Phone numbers have
 * country codes, spaces and leading zeros. Some rows have no name. Some are
 * the same person twice. One column holds the full name and another holds
 * nothing at all.
 *
 * The shape of the answer to that:
 *
 *   1. Parse and stage to the database, never hold the file in memory across
 *      requests. Hostinger kills a request at 120 seconds and there is no
 *      Redis — staging is what lets a 2,000-row import preview in one
 *      request and commit in batches afterwards.
 *   2. Report every problem against the row number in the user's own file,
 *      so they can fix it in Excel rather than guess.
 *   3. Never import a bad row silently and never fail the whole file for
 *      one. Good rows go in; the rest come back as a list to fix.
 *   4. Flag duplicates rather than block them — within the file and against
 *      members already on the books — because families share phone numbers
 *      and a gym knows its own people better than this does.
 */

export interface ImportContext {
  organizationId: string;
  userId: string;
  branchIds?: string[];
}

/** The member fields a spreadsheet column can be mapped onto. */
export type ImportField =
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'phone'
  | 'altPhone'
  | 'email'
  | 'memberCode'
  | 'dateOfBirth'
  | 'gender'
  | 'joiningDate'
  | 'addressLine1'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'emergencyContactName'
  | 'emergencyContactPhone'
  | 'occupation'
  | 'notes';

/**
 * What a header has to look like for a column to be recognised.
 *
 * Drawn from what gym software and Excel templates actually export, in
 * India especially: "Mobile No", "Contact Number", "DOB", "Join Date".
 */
const HEADER_SYNONYMS: Record<ImportField, string[]> = {
  fullName: ['fullname', 'name', 'membername', 'customername', 'client', 'clientname'],
  firstName: ['firstname', 'first', 'fname', 'givenname'],
  lastName: ['lastname', 'last', 'lname', 'surname', 'familyname'],
  phone: [
    'phone', 'mobile', 'mobileno', 'mobilenumber', 'contact', 'contactno',
    'contactnumber', 'phoneno', 'phonenumber', 'cell', 'cellno', 'whatsapp',
    'whatsappno', 'primaryphone',
  ],
  altPhone: ['altphone', 'alternatephone', 'alternateno', 'secondaryphone', 'phone2', 'mobile2'],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  memberCode: ['membercode', 'memberid', 'code', 'id', 'regno', 'registrationno', 'membershipno'],
  dateOfBirth: ['dateofbirth', 'dob', 'birthdate', 'birthday'],
  gender: ['gender', 'sex'],
  joiningDate: ['joiningdate', 'joindate', 'joined', 'doj', 'dateofjoining', 'startdate', 'admissiondate'],
  addressLine1: ['address', 'addressline1', 'address1', 'street', 'residence'],
  city: ['city', 'town', 'district'],
  state: ['state', 'province'],
  postalCode: ['postalcode', 'pincode', 'pin', 'zip', 'zipcode'],
  emergencyContactName: ['emergencycontact', 'emergencycontactname', 'emergencyname', 'guardian', 'guardianname'],
  emergencyContactPhone: [
    'emergencycontactphone',
    'emergencycontactnumber',
    'emergencycontactno',
    'emergencyphone',
    'emergencynumber',
    'emergencyno',
    'guardianphone',
    'guardiannumber',
  ],
  occupation: ['occupation', 'profession', 'job', 'work'],
  notes: ['notes', 'note', 'remarks', 'comment', 'comments'],
};

const normaliseHeader = (header: string): string =>
  header.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Guesses which column is which, and is honest about guessing.
 *
 * Returns a map from column index to field. The caller shows it and lets the
 * user correct it, because a wrong guess that imports silently is worse than
 * no guess at all.
 */
export function guessColumnMap(headers: string[]): Record<number, ImportField> {
  const map: Record<number, ImportField> = {};
  const taken = new Set<ImportField>();

  headers.forEach((header, index) => {
    const normalised = normaliseHeader(header);
    if (!normalised) return;

    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as Array<
      [ImportField, string[]]
    >) {
      if (taken.has(field)) continue;
      if (synonyms.includes(normalised)) {
        map[index] = field;
        taken.add(field);
        return;
      }
    }
  });

  /**
   * Only then: a header that merely contains a known word.
   *
   * The longest matching synonym wins, rather than whichever field happens
   * to be declared first. Declaration order sent "Emergency Contact Number"
   * to `emergencyContactName`, because "emergencycontact" is a substring of
   * it and that field comes first — so a gym's emergency phone number was
   * filed as the emergency contact's name. In the one field that exists for
   * an emergency.
   */
  headers.forEach((header, index) => {
    if (map[index]) return;
    const normalised = normaliseHeader(header);
    if (!normalised) return;

    let best: { field: ImportField; length: number } | null = null;

    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as Array<
      [ImportField, string[]]
    >) {
      if (taken.has(field)) continue;
      for (const synonym of synonyms) {
        if (synonym.length < 4) continue;
        if (!normalised.includes(synonym)) continue;
        if (!best || synonym.length > best.length) best = { field, length: synonym.length };
      }
    }

    if (best) {
      map[index] = best.field;
      taken.add(best.field);
    }
  });

  return map;
}

// ---------------------------------------------------------------- parsing ---

export interface ParsedRow {
  firstName?: string;
  lastName?: string;
  phone?: string;
  altPhone?: string;
  email?: string;
  memberCode?: string;
  dateOfBirth?: string;
  gender?: string;
  joiningDate?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  occupation?: string;
  notes?: string;
}

export interface RowIssue {
  field: string;
  issue: string;
}

/**
 * An Indian mobile number, however the spreadsheet wrote it.
 *
 * Excel turns a phone number into a float often enough that `9.82e9` has to
 * be handled, and a leading zero is lost the same way.
 */
export function normalisePhone(value: string): string | null {
  if (!value) return null;

  let text = value.trim();

  // Excel's scientific notation for a long number.
  if (/^\d(\.\d+)?e\+?\d+$/i.test(text)) {
    const expanded = Number(text);
    if (Number.isFinite(expanded)) text = expanded.toFixed(0);
  }

  const digits = text.replace(/\D/g, '');
  // Strip a country code or a trunk zero, then require a real mobile.
  const local = digits.replace(/^(?:0+|91)(?=\d{10}$)/, '');

  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

/** A date, in whichever of the four orders the file used. */
export function normaliseDate(value: string): string | null {
  if (!value) return null;
  const text = value.trim();

  // Already ISO.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Excel serial: days since 1899-12-30.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 0 && serial < 80_000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return date.toISOString().slice(0, 10);
    }
  }

  const parts = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/.exec(text);
  if (parts) {
    const [a, b, c] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];

    // yyyy/mm/dd
    if (a > 31) return validDate(a, b, c);

    const year = c < 100 ? (c > 50 ? 1900 + c : 2000 + c) : c;
    // Day-first, because that is how dates are written in India — and when
    // the first number is over 12 it cannot be a month anyway.
    if (a > 12) return validDate(year, b, a);
    return validDate(year, b, a);
  }

  // "15 March 2024" and similar.
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    return date.toISOString().slice(0, 10);
  }

  return null;
}

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function splitName(full: string): { firstName: string; lastName?: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '' };
  if (parts.length === 1) return { firstName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

const GENDERS: Record<string, string> = {
  m: 'MALE', male: 'MALE', man: 'MALE',
  f: 'FEMALE', female: 'FEMALE', woman: 'FEMALE',
  o: 'OTHER', other: 'OTHER',
};

/** Turns one spreadsheet row into member fields, and says what is wrong. */
export function parseRow(
  cells: string[],
  columnMap: Record<number, ImportField>,
): { parsed: ParsedRow; issues: RowIssue[] } {
  const raw: Partial<Record<ImportField, string>> = {};
  for (const [index, field] of Object.entries(columnMap)) {
    const value = cells[Number(index)]?.trim();
    if (value) raw[field] = value;
  }

  const issues: RowIssue[] = [];
  const parsed: ParsedRow = {};

  // --- name -------------------------------------------------------------
  if (raw.firstName || raw.lastName) {
    parsed.firstName = raw.firstName ?? '';
    parsed.lastName = raw.lastName;
    if (!parsed.firstName && raw.lastName) {
      const split = splitName(raw.lastName);
      parsed.firstName = split.firstName;
      parsed.lastName = split.lastName;
    }
  } else if (raw.fullName) {
    const split = splitName(raw.fullName);
    parsed.firstName = split.firstName;
    parsed.lastName = split.lastName;
  }

  if (!parsed.firstName) {
    issues.push({ field: 'name', issue: 'No name in this row' });
  }

  // --- phone ------------------------------------------------------------
  if (raw.phone) {
    const phone = normalisePhone(raw.phone);
    if (phone) parsed.phone = phone;
    else issues.push({ field: 'phone', issue: `"${raw.phone}" is not a 10-digit mobile number` });
  } else {
    issues.push({ field: 'phone', issue: 'No mobile number in this row' });
  }

  if (raw.altPhone) {
    const alt = normalisePhone(raw.altPhone);
    // A second number that will not parse is not worth rejecting a member for.
    if (alt) parsed.altPhone = alt;
  }

  if (raw.emergencyContactPhone) {
    const emergency = normalisePhone(raw.emergencyContactPhone);
    if (emergency) parsed.emergencyContactPhone = emergency;
  }

  // --- email ------------------------------------------------------------
  if (raw.email) {
    const email = raw.email.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) parsed.email = email;
    else issues.push({ field: 'email', issue: `"${raw.email}" is not an email address` });
  }

  // --- dates ------------------------------------------------------------
  for (const field of ['dateOfBirth', 'joiningDate'] as const) {
    const value = raw[field];
    if (!value) continue;
    const date = normaliseDate(value);
    if (date) parsed[field] = date;
    else issues.push({ field, issue: `"${value}" is not a date this can read` });
  }

  // --- the rest ---------------------------------------------------------
  if (raw.gender) {
    const gender = GENDERS[raw.gender.trim().toLowerCase()];
    if (gender) parsed.gender = gender;
  }
  if (raw.postalCode) {
    const pin = raw.postalCode.replace(/\D/g, '');
    if (/^\d{6}$/.test(pin)) parsed.postalCode = pin;
  }

  for (const field of [
    'memberCode',
    'addressLine1',
    'city',
    'state',
    'emergencyContactName',
    'occupation',
    'notes',
  ] as const) {
    const value = raw[field];
    if (value) parsed[field] = value.slice(0, 500);
  }

  return { parsed, issues };
}

// ---------------------------------------------------------------- staging ---

export interface ImportPreview {
  importId: string;
  filename: string;
  headers: string[];
  columnMap: Record<number, ImportField>;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  truncated: boolean;
  /** The first rows, as they would be imported, for the user to eyeball. */
  sample: Array<{
    rowNumber: number;
    status: string;
    parsed: ParsedRow;
    issues: RowIssue[];
    duplicateOf: { id: string; name: string; memberCode: string } | null;
  }>;
}

/**
 * Parses the file, stages every row, and reports what would happen.
 *
 * Nothing is created here. The user sees the counts and the problems first,
 * because an import that silently created four hundred half-right members
 * would be worse than no import at all.
 */
export async function stageImport(
  ctx: ImportContext,
  permissions: ResolvedPermissions,
  input: {
    bytes: Buffer;
    filename: string;
    branchId?: string;
    /** Overrides the guess, by column index. */
    columnMap?: Record<number, ImportField>;
  },
): Promise<ImportPreview> {
  requirePermission(permissions, 'members.member.create');

  let table: SheetTable;
  try {
    table = readSpreadsheet(input.bytes, input.filename);
  } catch (error) {
    if (error instanceof SpreadsheetError) {
      throw new AppError('VALIDATION_FAILED', error.message, [
        { field: 'file', issue: error.message },
      ]);
    }
    throw error;
  }

  const columnMap = input.columnMap ?? guessColumnMap(table.headers);

  const mapped = Object.values(columnMap);
  if (!mapped.includes('phone')) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No column in that file looks like a mobile number. Pick one before importing.',
      [{ field: 'columnMap', issue: 'A mobile number column is required' }],
    );
  }
  if (!mapped.some((field) => ['fullName', 'firstName', 'lastName'].includes(field))) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No column in that file looks like a name. Pick one before importing.',
      [{ field: 'columnMap', issue: 'A name column is required' }],
    );
  }

  return withTenant(ctx, async (tx) => {
    const record = await tx.memberImport.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId ?? null,
        filename: input.filename.slice(0, 200),
        sheetName: table.sheetName,
        status: 'READY',
        columnMap,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });

    // --- parse every row, then look for duplicates in one query ----------
    const prepared = table.rows.map((row) => {
      const { parsed, issues } = parseRow(row.cells, columnMap);
      return { rowNumber: row.rowNumber, cells: row.cells, parsed, issues };
    });

    const phones = [
      ...new Set(prepared.map((row) => row.parsed.phone).filter(Boolean) as string[]),
    ];

    const existing =
      phones.length > 0
        ? await tx.member.findMany({
            where: { phone: { in: phones }, deletedAt: null },
            select: { id: true, phone: true, memberCode: true, firstName: true, lastName: true },
          })
        : [];

    const byPhone = new Map(existing.map((member) => [member.phone, member]));
    const seenInFile = new Map<string, number>();

    let validRows = 0;
    let duplicateRows = 0;
    let invalidRows = 0;

    const toInsert = prepared.map((row) => {
      const issues = [...row.issues];
      let status: 'VALID' | 'INVALID' | 'DUPLICATE' = 'VALID';
      let duplicateOfMemberId: string | null = null;

      if (issues.length > 0) {
        status = 'INVALID';
      } else if (row.parsed.phone) {
        const already = byPhone.get(row.parsed.phone);
        const earlierRow = seenInFile.get(row.parsed.phone);

        if (already) {
          status = 'DUPLICATE';
          duplicateOfMemberId = already.id;
          issues.push({
            field: 'phone',
            issue: `Already a member — ${[already.firstName, already.lastName]
              .filter(Boolean)
              .join(' ')} (${already.memberCode})`,
          });
        } else if (earlierRow !== undefined) {
          status = 'DUPLICATE';
          issues.push({ field: 'phone', issue: `Same number as row ${earlierRow}` });
        } else {
          seenInFile.set(row.parsed.phone, row.rowNumber);
        }
      }

      if (status === 'VALID') validRows += 1;
      else if (status === 'DUPLICATE') duplicateRows += 1;
      else invalidRows += 1;

      return {
        organizationId: ctx.organizationId,
        importId: record.id,
        rowNumber: row.rowNumber,
        raw: row.cells,
        parsed: row.parsed as object,
        status,
        issues: issues.length > 0 ? issues : undefined,
        duplicateOfMemberId,
      };
    });

    // Chunked so a large file does not become one enormous statement.
    for (let i = 0; i < toInsert.length; i += 500) {
      await tx.memberImportRow.createMany({ data: toInsert.slice(i, i + 500) });
    }

    await tx.memberImport.update({
      where: { id: record.id },
      data: {
        totalRows: prepared.length,
        validRows,
        duplicateRows,
        invalidRows,
      },
    });

    const sample = await tx.memberImportRow.findMany({
      where: { importId: record.id },
      orderBy: { rowNumber: 'asc' },
      take: 25,
      select: {
        rowNumber: true,
        status: true,
        parsed: true,
        issues: true,
        duplicateOfMemberId: true,
      },
    });

    const duplicateIds = sample
      .map((row: { duplicateOfMemberId: string | null }) => row.duplicateOfMemberId)
      .filter(Boolean) as string[];

    const duplicates =
      duplicateIds.length > 0
        ? await tx.member.findMany({
            where: { id: { in: duplicateIds } },
            select: { id: true, memberCode: true, firstName: true, lastName: true },
          })
        : [];
    const duplicateById = new Map(duplicates.map((member) => [member.id, member]));

    return {
      importId: record.id,
      filename: input.filename,
      headers: table.headers,
      columnMap,
      totalRows: prepared.length,
      validRows,
      duplicateRows,
      invalidRows,
      truncated: table.truncated,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sample: sample.map((row: any) => {
        const duplicate = row.duplicateOfMemberId
          ? duplicateById.get(row.duplicateOfMemberId)
          : null;
        return {
          rowNumber: row.rowNumber,
          status: row.status,
          parsed: (row.parsed ?? {}) as ParsedRow,
          issues: (row.issues ?? []) as RowIssue[],
          duplicateOf: duplicate
            ? {
                id: duplicate.id,
                name: [duplicate.firstName, duplicate.lastName].filter(Boolean).join(' '),
                memberCode: duplicate.memberCode,
              }
            : null,
        };
      }),
    };
  });
}

// --------------------------------------------------------------- committing ---

export interface CommitResult {
  importId: string;
  status: string;
  created: number;
  skipped: number;
  remaining: number;
  /** True when there is more to do and this should be called again. */
  hasMore: boolean;
}

/**
 * Creates the members, a batch at a time.
 *
 * Batched and resumable rather than one long transaction, for three reasons
 * that all point the same way on shared hosting:
 *
 *   - Hostinger kills a request at 120 seconds. A 2,000-member import in one
 *     transaction would be killed partway and roll back everything, every
 *     time, with no way for the user to make progress.
 *   - Each batch commits on its own, so a file that fails at row 1,500
 *     leaves the first 1,499 members imported rather than nothing.
 *   - It is idempotent per row: a row already marked CREATED is never
 *     created twice, so calling this again after a timeout resumes instead
 *     of duplicating.
 *
 * `skipRows` are the rows the user unticked in the preview; duplicates are
 * skipped unless `includeDuplicates` says otherwise, because a gym knows its
 * own families better than this does.
 */
export async function commitImport(
  ctx: ImportContext,
  permissions: ResolvedPermissions,
  input: {
    importId: string;
    skipRows?: number[];
    includeDuplicates?: boolean;
    /** Rows per call. Kept well inside the request budget. */
    batchSize?: number;
  },
  meta: { ipAddress?: string } = {},
): Promise<CommitResult> {
  requirePermission(permissions, 'members.member.create');

  const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 500);
  const skip = new Set(input.skipRows ?? []);

  return withTenant(ctx, async (tx) => {
    const record = await tx.memberImport.findFirst({
      where: { id: input.importId },
      select: {
        id: true,
        status: true,
        branchId: true,
        createdCount: true,
        skippedCount: true,
      },
    });
    if (!record) throw new AppError('NOT_FOUND', 'That import was not found.');
    if (record.status === 'COMPLETED') {
      throw new AppError('CONFLICT', 'That import has already been committed.');
    }

    /**
     * Every member needs a branch.
     *
     * Not cosmetic: a staff member whose read scope is branch-limited sees
     * members by branch, so a member with none is invisible to them. An
     * import that left this null produced four hundred members the gym
     * could not see on its own members screen — the worst possible first
     * five minutes with the product.
     *
     * Falls back to the primary branch, exactly as registering a member by
     * hand does.
     */
    const branchId =
      record.branchId ??
      (
        await tx.branch.findFirst({
          where: { isActive: true, deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { id: true },
        })
      )?.id ??
      null;

    const wanted: Array<'VALID' | 'DUPLICATE'> = input.includeDuplicates
      ? ['VALID', 'DUPLICATE']
      : ['VALID'];

    const batch = await tx.memberImportRow.findMany({
      where: { importId: record.id, status: { in: wanted } },
      orderBy: { rowNumber: 'asc' },
      take: batchSize,
      select: { id: true, rowNumber: true, parsed: true },
    });

    let created = 0;
    let skipped = 0;

    for (const row of batch) {
      if (skip.has(row.rowNumber)) {
        await tx.memberImportRow.update({
          where: { id: row.id },
          data: { status: 'SKIPPED' },
        });
        skipped += 1;
        continue;
      }

      const parsed = (row.parsed ?? {}) as ParsedRow;
      if (!parsed.firstName || !parsed.phone) {
        await tx.memberImportRow.update({
          where: { id: row.id },
          data: { status: 'INVALID' },
        });
        skipped += 1;
        continue;
      }

      // A code from the file is kept when it is free, so a gym's own
      // numbering survives the move; otherwise the next one is allocated.
      let memberCode: string | undefined = parsed.memberCode
        ?.trim()
        .toUpperCase()
        .slice(0, 40);

      if (memberCode) {
        const clash = await tx.member.findFirst({
          where: { memberCode },
          select: { id: true },
        });
        if (clash) memberCode = undefined;
      }

      const finalCode = memberCode ?? (await allocateMemberCode(tx, ctx.organizationId));

      const member = await tx.member.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          memberCode: finalCode,
          firstName: parsed.firstName.slice(0, 80),
          lastName: parsed.lastName?.slice(0, 80) ?? null,
          phone: parsed.phone,
          altPhone: parsed.altPhone ?? null,
          email: parsed.email ?? null,
          dateOfBirth: parsed.dateOfBirth ? startOfDay(parsed.dateOfBirth) : null,
          gender: (parsed.gender as never) ?? undefined,
          joiningDate: parsed.joiningDate ? startOfDay(parsed.joiningDate) : new Date(),
          addressLine1: parsed.addressLine1 ?? null,
          city: parsed.city ?? null,
          state: parsed.state ?? null,
          postalCode: parsed.postalCode ?? null,
          emergencyContactName: parsed.emergencyContactName ?? null,
          emergencyContactPhone: parsed.emergencyContactPhone ?? null,
          occupation: parsed.occupation ?? null,
          notes: parsed.notes ?? null,
          // Imported members start inactive: the file says who they are,
          // not what they have paid for. A membership is sold afterwards,
          // which is also what makes the dashboard's numbers honest on day
          // one rather than showing four hundred active members who are not.
          status: 'INACTIVE',
        },
        select: { id: true },
      });

      await tx.memberImportRow.update({
        where: { id: row.id },
        data: { status: 'CREATED', memberId: member.id },
      });

      created += 1;
    }

    const remaining = await tx.memberImportRow.count({
      where: { importId: record.id, status: { in: wanted } },
    });

    const totals = {
      createdCount: record.createdCount + created,
      skippedCount: record.skippedCount + skipped,
    };
    const done = remaining === 0;

    await tx.memberImport.update({
      where: { id: record.id },
      data: {
        ...totals,
        status: done ? 'COMPLETED' : 'COMMITTING',
        committedAt: done ? new Date() : null,
      },
    });

    if (done) {
      await writeAudit(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'members.imported',
        entityType: 'MemberImport',
        entityId: record.id,
        summary: `Imported ${totals.createdCount} members, skipped ${totals.skippedCount}`,
        ipAddress: meta.ipAddress,
      });
    }

    return {
      importId: record.id,
      status: done ? 'COMPLETED' : 'COMMITTING',
      created: totals.createdCount,
      skipped: totals.skippedCount,
      remaining,
      hasMore: !done,
    };
  });
}

/** The rows that need a human to look at them, for the fix-it list. */
export async function getImportProblems(
  ctx: ImportContext,
  permissions: ResolvedPermissions,
  importId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{
  rows: Array<{
    rowNumber: number;
    status: string;
    parsed: ParsedRow;
    issues: RowIssue[];
  }>;
  total: number;
}> {
  requirePermission(permissions, 'members.member.read');

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(options.pageSize ?? 50, 200);

  return withTenant(ctx, async (tx) => {
    const where = {
      importId,
      status: { in: ['INVALID' as const, 'DUPLICATE' as const] },
    };

    const [rows, total] = await Promise.all([
      tx.memberImportRow.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { rowNumber: true, status: true, parsed: true, issues: true },
      }),
      tx.memberImportRow.count({ where }),
    ]);

    return {
      total,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows: rows.map((row: any) => ({
        rowNumber: row.rowNumber,
        status: row.status,
        parsed: (row.parsed ?? {}) as ParsedRow,
        issues: (row.issues ?? []) as RowIssue[],
      })),
    };
  });
}

/** Recent imports, so a gym can see what it has already brought in. */
export async function listImports(
  ctx: ImportContext,
  permissions: ResolvedPermissions,
  options: { limit?: number } = {},
) {
  requirePermission(permissions, 'members.member.read');

  return withTenant(ctx, (tx) =>
    tx.memberImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 20, 50),
      select: {
        id: true,
        filename: true,
        status: true,
        totalRows: true,
        validRows: true,
        duplicateRows: true,
        invalidRows: true,
        createdCount: true,
        skippedCount: true,
        createdAt: true,
        committedAt: true,
      },
    }),
  );
}
