/**
 * Bringing a gym's existing members in from a spreadsheet.
 *
 * This is the step that decides whether a gym can switch at all — nobody
 * retypes four hundred members — so it is tested against files that look
 * like the ones gyms actually have: country codes, leading zeros, Excel's
 * scientific notation, four different date orders, blank rows, duplicate
 * numbers, and a single "Name" column holding the whole name.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authPrisma } from '@gym/db';
import {
  registerGym,
  createSession,
  resolveSession,
  createMember,
  listMembers,
  stageImport,
  commitImport,
  getImportProblems,
  listImports,
  guessColumnMap,
  parseRow,
  normalisePhone,
  normaliseDate,
  readSpreadsheet,
  readCsv,
  SpreadsheetError,
  AppError,
} from '@gym/core';

const db = new PrismaClient({ datasources: { db: { url: process.env.JOBS_DATABASE_URL } } });
const unique = () => Math.random().toString(36).slice(2, 8);
const PASSWORD = 'correct horse battery staple 47';

let gym: Awaited<ReturnType<typeof registerGym>>;
let ctx: { organizationId: string; userId: string };
let owner: Awaited<ReturnType<typeof resolveSession>>['actor']['permissions'];

const createdOrgIds: string[] = [];
const createdEmails: string[] = [];

const csv = (text: string): Buffer => Buffer.from(text, 'utf8');

beforeAll(async () => {
  const email = `import.${unique()}@example.com`;
  createdEmails.push(email);

  gym = await registerGym({
    gymName: `Import Gym ${unique()}`,
    ownerName: 'Import Owner',
    email,
    phone: '9876540000',
    password: PASSWORD,
    planKey: 'PROFESSIONAL',
    acceptedTerms: true,
  });
  createdOrgIds.push(gym.organizationId);
  ctx = { organizationId: gym.organizationId, userId: gym.userId };

  const session = await createSession(authPrisma, {
    userId: gym.userId,
    organizationId: gym.organizationId,
    type: 'WEB',
  });
  owner = (await resolveSession(authPrisma, session.token)).actor.permissions;
});

afterAll(async () => {
  await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
  await db.user.deleteMany({ where: { email: { in: createdEmails } } });
  await db.$disconnect();
});

// =========================================================================
//  Phone numbers, as spreadsheets mangle them
// =========================================================================

describe('phone numbers', () => {
  it('accepts every way a mobile number gets written into a cell', () => {
    for (const written of [
      '9820000001',
      '+919820000001',
      '91 9820000001',
      '09820000001',
      '+91 98200 00001',
      '98200-00001',
      ' 9820000001 ',
      '(+91) 9820000001',
    ]) {
      expect(normalisePhone(written), written).toBe('9820000001');
    }
  });

  it("survives Excel turning the number into a float", () => {
    // Excel stores a long number as a double and shows 9.82E+09.
    expect(normalisePhone('9.820000001e9')).toBe('9820000001');
    expect(normalisePhone('9.820000001E+09')).toBe('9820000001');
  });

  it('refuses what is not an Indian mobile', () => {
    for (const bad of ['1234567890', '5820000001', '982000000', '98200000012', '', 'none', 'N/A']) {
      expect(normalisePhone(bad), bad).toBeNull();
    }
  });
});

// =========================================================================
//  Dates, in whichever order the file used
// =========================================================================

describe('dates', () => {
  it('reads the orders a spreadsheet actually contains', () => {
    expect(normaliseDate('2024-03-15')).toBe('2024-03-15');
    expect(normaliseDate('15/03/2024')).toBe('2024-03-15');
    expect(normaliseDate('15-03-2024')).toBe('2024-03-15');
    expect(normaliseDate('15.03.2024')).toBe('2024-03-15');
    expect(normaliseDate('2024/03/15')).toBe('2024-03-15');
    expect(normaliseDate('15/03/24')).toBe('2024-03-15');
  });

  it('reads day-first, because that is how dates are written in India', () => {
    // 03/04/2024 is 3 April here, not 4 March.
    expect(normaliseDate('03/04/2024')).toBe('2024-04-03');
  });

  it('converts an Excel serial date', () => {
    // 45366 is 15 March 2024 in Excel's numbering.
    expect(normaliseDate('45366')).toBe('2024-03-15');
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(normaliseDate('31/02/2024')).toBeNull();
    expect(normaliseDate('32/01/2024')).toBeNull();
    expect(normaliseDate('not a date')).toBeNull();
    expect(normaliseDate('')).toBeNull();
  });

  it('handles a leap day correctly', () => {
    expect(normaliseDate('29/02/2024')).toBe('2024-02-29');
    expect(normaliseDate('29/02/2023')).toBeNull();
  });
});

// =========================================================================
//  Working out which column is which
// =========================================================================

describe('guessing the columns', () => {
  it('recognises the headers gym software exports', () => {
    const map = guessColumnMap(['Member Name', 'Mobile No', 'Email ID', 'DOJ', 'DOB', 'City']);
    expect(map[0]).toBe('fullName');
    expect(map[1]).toBe('phone');
    expect(map[2]).toBe('email');
    expect(map[3]).toBe('joiningDate');
    expect(map[4]).toBe('dateOfBirth');
    expect(map[5]).toBe('city');
  });

  it('keeps first and last name apart when the file does', () => {
    const map = guessColumnMap(['First Name', 'Last Name', 'Contact Number']);
    expect(map[0]).toBe('firstName');
    expect(map[1]).toBe('lastName');
    expect(map[2]).toBe('phone');
  });

  it('does not let an emergency number win the phone column', () => {
    const map = guessColumnMap(['Name', 'Emergency Contact Number', 'Mobile']);
    expect(map[2], 'the real mobile column').toBe('phone');
    expect(map[1]).toBe('emergencyContactPhone');
  });

  it('leaves a column it does not recognise unmapped rather than guessing', () => {
    const map = guessColumnMap(['Name', 'Mobile', 'Locker Number', 'Trainer Preference']);
    expect(map[2]).toBeUndefined();
    expect(map[3]).toBeUndefined();
  });
});

// =========================================================================
//  Turning a row into a member
// =========================================================================

describe('reading a row', () => {
  const map = { 0: 'fullName', 1: 'phone', 2: 'email' } as const;

  it('splits a full name into first and last', () => {
    const { parsed, issues } = parseRow(['Ravi Kulkarni', '9820000001', ''], map as never);
    expect(parsed.firstName).toBe('Ravi');
    expect(parsed.lastName).toBe('Kulkarni');
    expect(issues).toHaveLength(0);
  });

  it('keeps a middle name with the surname rather than dropping it', () => {
    const { parsed } = parseRow(['Ravi Shankar Kulkarni', '9820000001', ''], map as never);
    expect(parsed.firstName).toBe('Ravi');
    expect(parsed.lastName).toBe('Shankar Kulkarni');
  });

  it('accepts a single-word name', () => {
    const { parsed, issues } = parseRow(['Ravi', '9820000001', ''], map as never);
    expect(parsed.firstName).toBe('Ravi');
    expect(parsed.lastName).toBeUndefined();
    expect(issues).toHaveLength(0);
  });

  it('says which field is wrong, in words the person can act on', () => {
    const { issues } = parseRow(['', 'abc', 'not-an-email'], map as never);
    expect(issues.map((i) => i.field).sort()).toEqual(['email', 'name', 'phone']);
    expect(issues.find((i) => i.field === 'phone')?.issue).toContain('abc');
  });

  it('does not reject a member over a bad second phone number', () => {
    const wide = { 0: 'fullName', 1: 'phone', 2: 'altPhone' } as const;
    const { parsed, issues } = parseRow(['Ravi', '9820000001', 'rubbish'], wide as never);
    expect(issues).toHaveLength(0);
    expect(parsed.altPhone).toBeUndefined();
  });
});

// =========================================================================
//  The file itself
// =========================================================================

describe('reading the file', () => {
  it('reads a quoted CSV with commas and newlines inside fields', () => {
    const table = readCsv(
      'Name,Mobile,City\n"Kulkarni, Ravi",9820000001,"Pune, MH"\n"Multi\nline",9820000002,Mumbai\n',
    );
    expect(table.headers).toEqual(['Name', 'Mobile', 'City']);
    expect(table.rows[0]!.cells[0]).toBe('Kulkarni, Ravi');
    expect(table.rows[0]!.cells[2]).toBe('Pune, MH');
    expect(table.rows[1]!.cells[0]).toBe('Multi\nline');
  });

  it('detects a semicolon-separated file, which Excel writes in some locales', () => {
    const table = readCsv('Name;Mobile;City\nRavi;9820000001;Pune\n');
    expect(table.headers).toEqual(['Name', 'Mobile', 'City']);
    expect(table.rows[0]!.cells).toEqual(['Ravi', '9820000001', 'Pune']);
  });

  it('keeps the spreadsheet’s own row numbers past a blank row', () => {
    // The whole point: "row 5 is missing a phone number" has to mean row 5
    // of the file the person is looking at.
    const table = readCsv('Name,Mobile\nRavi,9820000001\n\nPriya,9820000002\n');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.rowNumber).toBe(2);
    expect(table.rows[1]!.rowNumber, 'row 4, not row 3').toBe(4);
  });

  it('strips a UTF-8 byte order mark, which Excel adds', () => {
    const table = readCsv('﻿Name,Mobile\nRavi,9820000001\n');
    expect(table.headers[0]).toBe('Name');
  });

  it('refuses an empty file and an old .xls', () => {
    expect(() => readSpreadsheet(Buffer.from(''), 'x.csv')).toThrow(SpreadsheetError);
    expect(() => readSpreadsheet(Buffer.from('rubbish'), 'old.xls')).toThrow(/xlsx or CSV/);
  });

  it('refuses something that is not a spreadsheet at all', () => {
    // A ZIP that is not an xlsx must fail cleanly, not half-parse.
    const notXlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
    expect(() => readSpreadsheet(notXlsx, 'thing.xlsx')).toThrow(SpreadsheetError);
  });
});

// =========================================================================
//  Staging and committing, end to end
// =========================================================================

describe('a real .xlsx file', () => {
  // A checked-in file in Excel's actual format, not a string pretending to
  // be one: the reader is hand-written, so it is worth proving against the
  // real thing — shared strings, typed cells, a date cell and all.
  const fixture = () =>
    readFileSync(new URL('../fixtures/members.xlsx', import.meta.url));

  it('reads the sheet, its shared strings and its dates', () => {
    const table = readSpreadsheet(fixture(), 'members.xlsx');

    expect(table.headers).toEqual([
      'Member Name',
      'Mobile No',
      'Email ID',
      'DOJ',
      'City',
      'Locker',
    ]);
    expect(table.rows).toHaveLength(5);
    expect(table.rows[0]!.cells[0]).toBe('Ravi Kulkarni');
    // A quote inside a cell survives the XML round trip.
    expect(table.rows[2]!.cells[0]).toBe('Amit "AJ" Joshi');
  });

  it('keeps the sheet’s own row numbers past the blank row', () => {
    const table = readSpreadsheet(fixture(), 'members.xlsx');
    expect(table.rows[2]!.rowNumber).toBe(4);
    expect(table.rows[3]!.rowNumber, 'row 6, because row 5 is blank').toBe(6);
  });

  it('imports it end to end', async () => {
    const preview = await stageImport(ctx, owner, {
      bytes: fixture(),
      filename: 'members.xlsx',
    });

    expect(preview.columnMap[0]).toBe('fullName');
    expect(preview.columnMap[1]).toBe('phone');
    expect(preview.columnMap[3]).toBe('joiningDate');
    // A column it does not recognise is left alone rather than guessed at.
    expect(preview.columnMap[5]).toBeUndefined();

    expect(preview.validRows).toBe(4);
    expect(preview.duplicateRows, 'Vikram repeats Ravi’s number').toBe(1);

    const result = await commitImport(ctx, owner, { importId: preview.importId });
    expect(result.created).toBe(4);

    const ravi = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9840000001' },
    });
    expect(ravi.lastName).toBe('Kulkarni');
    // Excel stores this as a serial number; it has to come back as the date.
    expect(ravi.joiningDate.toISOString().slice(0, 10)).toBe('2024-03-15');

    // A number Excel held as a float, not a string.
    const priya = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9840000002' },
    });
    expect(priya.firstName).toBe('Priya');
  });
});

describe('importing a gym’s member list', () => {
  const file = [
    'Member Name,Mobile No,Email ID,DOJ,City',
    'Ravi Kulkarni,9820000001,ravi@example.com,15/03/2024,Pune',
    'Priya Deshmukh,+91 9820000002,,01/04/2024,Mumbai',
    'Amit Joshi,09820000003,amit@example.com,45366,Nashik',
    ',9820000004,,,Pune',                               // no name
    'Sneha Patil,not-a-number,sneha@example.com,,Pune', // no usable phone
    'Vikram Shinde,9820000001,vikram@example.com,,Pune', // same number as row 2
    '',                                                  // blank
    'Anjali Rao,9820000005,anjali@example.com,20/05/2024,Pune',
  ].join('\n');

  let importId: string;

  it('counts what would happen before anything is created', async () => {
    const preview = await stageImport(ctx, owner, {
      bytes: csv(file),
      filename: 'members.csv',
    });
    importId = preview.importId;

    expect(preview.columnMap[0]).toBe('fullName');
    expect(preview.columnMap[1]).toBe('phone');

    expect(preview.totalRows).toBe(7);
    expect(preview.validRows).toBe(4);
    expect(preview.invalidRows, 'the nameless row and the unusable number').toBe(2);
    expect(preview.duplicateRows, 'the repeated number').toBe(1);

    // And nothing from this file exists yet.
    const members = await listMembers(ctx, owner, { search: '98200000', pageSize: 100 });
    expect(members.total).toBe(0);
  });

  it('reports each problem against the row number in the user’s own file', async () => {
    const problems = await getImportProblems(ctx, owner, importId);

    const rows = Object.fromEntries(problems.rows.map((row) => [row.rowNumber, row]));
    expect(rows[5]!.issues.some((i) => i.field === 'name')).toBe(true);
    expect(rows[6]!.issues.some((i) => i.issue.includes('not-a-number'))).toBe(true);
    expect(rows[7]!.issues.some((i) => i.issue.includes('row 2'))).toBe(true);
  });

  it('creates the good rows and leaves the rest alone', async () => {
    const result = await commitImport(ctx, owner, { importId });

    expect(result.status).toBe('COMPLETED');
    expect(result.created).toBe(4);
    expect(result.hasMore).toBe(false);

    const members = await listMembers(ctx, owner, { search: '98200000', pageSize: 100 });
    expect(members.total).toBe(4);

    const ravi = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9820000001' },
    });
    expect(ravi.firstName).toBe('Ravi');
    expect(ravi.lastName).toBe('Kulkarni');
    expect(ravi.email).toBe('ravi@example.com');
    expect(ravi.city).toBe('Pune');
    expect(ravi.joiningDate.toISOString().slice(0, 10)).toBe('2024-03-15');
    expect(ravi.memberCode).toMatch(/^M\d{5}$/);
    // Imported members start inactive: the file says who they are, not what
    // they have paid for.
    expect(ravi.status).toBe('INACTIVE');
  });

  it('reads the Excel serial date the same as a written one', async () => {
    const amit = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9820000003' },
    });
    expect(amit.joiningDate.toISOString().slice(0, 10)).toBe('2024-03-15');
  });

  it('refuses to commit the same import twice', async () => {
    await expect(commitImport(ctx, owner, { importId })).rejects.toThrow(AppError);
  });

  it('flags a second upload of the same file as already imported', async () => {
    const preview = await stageImport(ctx, owner, {
      bytes: csv(file),
      filename: 'members.csv',
    });

    // Every member it would create is already on the books.
    expect(preview.validRows).toBe(0);
    expect(preview.duplicateRows).toBe(5);

    const result = await commitImport(ctx, owner, { importId: preview.importId });
    expect(result.created, 'nothing is created twice').toBe(0);

    const members = await listMembers(ctx, owner, { search: '98200000', pageSize: 100 });
    expect(members.total).toBe(4);
  });
});

describe('the import’s own rules', () => {
  it('will not import a file with no phone column', async () => {
    await expect(
      stageImport(ctx, owner, {
        bytes: csv('Name,City\nRavi,Pune\n'),
        filename: 'no-phone.csv',
      }),
    ).rejects.toThrow(/mobile number/i);
  });

  it('will not import a file with no name column', async () => {
    await expect(
      stageImport(ctx, owner, {
        bytes: csv('Mobile,City\n9820000099,Pune\n'),
        filename: 'no-name.csv',
      }),
    ).rejects.toThrow(/name/i);
  });

  it('honours a column map the user corrected', async () => {
    // The headers are meaningless, so the guess would fail; the user says
    // which column is which and it imports anyway.
    const preview = await stageImport(ctx, owner, {
      bytes: csv('Col1,Col2\nMeera Nair,9820000010\n'),
      filename: 'odd-headers.csv',
      columnMap: { 0: 'fullName', 1: 'phone' },
    });

    expect(preview.validRows).toBe(1);
    await commitImport(ctx, owner, { importId: preview.importId });

    const meera = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9820000010' },
    });
    expect(meera.firstName).toBe('Meera');
  });

  it('keeps the gym’s own member codes when they are free', async () => {
    const preview = await stageImport(ctx, owner, {
      bytes: csv('Name,Mobile,Member Code\nKiran Rao,9820000011,OLD-114\n'),
      filename: 'with-codes.csv',
    });
    await commitImport(ctx, owner, { importId: preview.importId });

    const kiran = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9820000011' },
    });
    expect(kiran.memberCode, 'a gym’s own numbering survives the move').toBe('OLD-114');
  });

  it('allocates a new code when the file’s one is taken', async () => {
    const preview = await stageImport(ctx, owner, {
      bytes: csv('Name,Mobile,Member Code\nAsha Pawar,9820000012,OLD-114\n'),
      filename: 'clashing-codes.csv',
    });
    await commitImport(ctx, owner, { importId: preview.importId });

    const asha = await db.member.findFirstOrThrow({
      where: { organizationId: gym.organizationId, phone: '9820000012' },
    });
    expect(asha.memberCode).not.toBe('OLD-114');
    expect(asha.memberCode).toMatch(/^M\d{5}$/);
  });

  it('skips the rows the user unticked', async () => {
    const preview = await stageImport(ctx, owner, {
      bytes: csv(
        'Name,Mobile\nWanted One,9820000021\nNot Wanted,9820000022\nWanted Two,9820000023\n',
      ),
      filename: 'partial.csv',
    });

    const result = await commitImport(ctx, owner, {
      importId: preview.importId,
      skipRows: [3],
    });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);

    const rejected = await db.member.findFirst({
      where: { organizationId: gym.organizationId, phone: '9820000022' },
    });
    expect(rejected).toBeNull();
  });

  it('commits in batches and resumes where it stopped', async () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `Batch Member${i},98300000${String(i).padStart(2, '0')}`,
    );
    const preview = await stageImport(ctx, owner, {
      bytes: csv(['Name,Mobile', ...rows].join('\n')),
      filename: 'batched.csv',
    });
    expect(preview.validRows).toBe(12);

    // A deliberately tiny batch, standing in for the request budget running
    // out on a large file.
    const first = await commitImport(ctx, owner, {
      importId: preview.importId,
      batchSize: 5,
    });
    expect(first.created).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.remaining).toBe(7);

    const second = await commitImport(ctx, owner, {
      importId: preview.importId,
      batchSize: 5,
    });
    expect(second.created, 'the running total, not the batch').toBe(10);
    expect(second.hasMore).toBe(true);

    const third = await commitImport(ctx, owner, {
      importId: preview.importId,
      batchSize: 5,
    });
    expect(third.created).toBe(12);
    expect(third.hasMore).toBe(false);
    expect(third.status).toBe('COMPLETED');

    const created = await db.member.count({
      where: { organizationId: gym.organizationId, phone: { startsWith: '983' } },
    });
    expect(created, 'twelve members, none of them twice').toBe(12);
  });

  it('lists what has been imported', async () => {
    const imports = await listImports(ctx, owner);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports[0]!.filename).toBeTruthy();
    expect(imports.some((row) => row.status === 'COMPLETED')).toBe(true);
  });
});

// =========================================================================
//  Isolation — an import is tenant data like any other
// =========================================================================

describe('an import belongs to one gym', () => {
  it('is invisible to another gym', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirImports = await db.memberImport.count({
      where: { organizationId: otherOrg.id },
    });
    expect(theirImports, 'nothing of ours leaked into theirs').toBe(0);

    const ours = await listImports(ctx, owner);
    for (const row of ours) {
      const record = await db.memberImport.findUniqueOrThrow({ where: { id: row.id } });
      expect(record.organizationId).toBe(gym.organizationId);
    }
  });

  it('refuses to commit another gym’s import', async () => {
    const otherOrg = await db.organization.findFirstOrThrow({ where: { slug: 'iron-temple' } });
    const theirs = await db.memberImport.create({
      data: {
        organizationId: otherOrg.id,
        filename: 'theirs.csv',
        status: 'READY',
      },
      select: { id: true },
    });

    await expect(commitImport(ctx, owner, { importId: theirs.id })).rejects.toThrow(AppError);
    await db.memberImport.delete({ where: { id: theirs.id } });
  });
});
