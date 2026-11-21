import { inflateRawSync } from 'node:zlib';

/**
 * Reading a spreadsheet a gym uploaded.
 *
 * This is hand-written rather than a library, and that is a deliberate
 * security decision rather than an exercise:
 *
 *   - The newest `xlsx` (SheetJS) on npm is 0.18.5, which carries a
 *     prototype-pollution advisory (CVE-2023-30533). Later versions are only
 *     on the vendor's own CDN. Parsing files uploaded by staff is exactly the
 *     reachable path such a bug needs, so that package is out.
 *   - `exceljs` is 21 MB unpacked. On Hostinger that is inode budget and
 *     deploy weight on a plan already running several sites.
 *
 * So this reads only what a flat table needs: the first worksheet's cells and
 * the shared string table. It never evaluates a formula, never follows an
 * external reference, never runs a macro, and never builds an object from
 * attacker-controlled keys. Anything it does not understand is ignored rather
 * than guessed at.
 *
 * It is deliberately bounded — compressed size, inflated size, row count and
 * cell count all have ceilings — because the input is a file a stranger can
 * hand the server and a zip bomb is three lines of Python.
 */

export interface SheetTable {
  /** The header row, trimmed, in file order. */
  headers: string[];
  /** Data rows. Each is aligned to `headers` by position. */
  rows: Array<{ rowNumber: number; cells: string[] }>;
  sheetName: string | null;
  /** True when the file was longer than `maxRows` and was cut short. */
  truncated: boolean;
}

export class SpreadsheetError extends Error {}

const LIMITS = {
  /** 10 MB of upload. A gym's member list is tens of kilobytes. */
  maxBytes: 10 * 1024 * 1024,
  /** 80 MB inflated. Past this it is a zip bomb, not a member list. */
  maxInflatedBytes: 80 * 1024 * 1024,
  maxRows: 20_000,
  maxColumns: 64,
  maxCellLength: 2000,
};

// ============================================================== detection ==

export function looksLikeXlsx(bytes: Buffer): boolean {
  // Every xlsx is a ZIP, and every ZIP starts PK\x03\x04.
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function readSpreadsheet(bytes: Buffer, filename = ''): SheetTable {
  if (bytes.length === 0) throw new SpreadsheetError('That file is empty.');
  if (bytes.length > LIMITS.maxBytes) {
    throw new SpreadsheetError(
      `That file is larger than ${Math.round(LIMITS.maxBytes / 1024 / 1024)} MB.`,
    );
  }

  if (looksLikeXlsx(bytes)) return readXlsx(bytes);

  if (/\.xls$/i.test(filename)) {
    throw new SpreadsheetError(
      'That is an old .xls file. Open it in Excel and save it as .xlsx or CSV first.',
    );
  }

  return readCsv(bytes.toString('utf8'));
}

// ==================================================================== CSV ==

/**
 * RFC 4180 with the concessions real files need: a UTF-8 BOM, CRLF or LF,
 * quoted fields containing commas and newlines, and `""` as an escaped quote.
 * Semicolon-separated files are detected too, because Excel writes those in
 * locales where the comma is a decimal separator.
 */
export function readCsv(text: string): SheetTable {
  const body = text.replace(/^\uFEFF/, '');
  if (!body.trim()) throw new SpreadsheetError('That file has no rows in it.');

  const delimiter = detectDelimiter(body);
  const records: Array<{ rowNumber: number; cells: string[] }> = [];
  const push = (cells: string[]) => records.push({ rowNumber: records.length + 1, cells });

  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let truncated = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      push(record);
      record = [];

      if (records.length > LIMITS.maxRows) {
        truncated = true;
        break;
      }
    } else {
      field += char;
    }
  }

  if (field.length > 0 || record.length > 0) {
    record.push(field);
    push(record);
  }

  return toTable(records, null, truncated);
}

function detectDelimiter(sample: string): string {
  const firstLine = sample.slice(0, 4000).split(/\r?\n/)[0] ?? '';
  // Count outside quotes only, so "Patil, Priya" does not vote for a comma.
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;
  let quoted = false;

  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') commas += 1;
    else if (!quoted && char === ';') semicolons += 1;
    else if (!quoted && char === '\t') tabs += 1;
  }

  if (tabs > commas && tabs > semicolons) return '\t';
  if (semicolons > commas) return ';';
  return ',';
}

// =================================================================== XLSX ==

function readXlsx(bytes: Buffer): SheetTable {
  const entries = readZipEntries(bytes);

  const sheetPath =
    firstSheetPath(entries) ??
    [...entries.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));

  if (!sheetPath) {
    throw new SpreadsheetError('That .xlsx file has no readable worksheet in it.');
  }

  const sharedStrings = readSharedStrings(entries);
  const sheetXml = decode(entries.get(sheetPath)!);

  const rows: Array<{ rowNumber: number; cells: string[] }> = [];
  let truncated = false;

  // One row element at a time, so a large sheet is never held twice.
  const rowPattern = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(sheetXml)) !== null) {
    if (rows.length >= LIMITS.maxRows) {
      truncated = true;
      break;
    }

    const rowNumber = Number(rowMatch[1] ?? 0);
    const inner = rowMatch[2] ?? '';
    if (!rowNumber || !inner) continue;

    const cells: string[] = [];
    const cellPattern = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellPattern.exec(inner)) !== null) {
      const attributes = cellMatch[1] ?? '';
      const content = cellMatch[2] ?? '';

      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const column = reference ? columnIndex(reference) : cells.length;
      if (column >= LIMITS.maxColumns) continue;

      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n';
      let value: string;

      if (type === 's') {
        // Shared string: the cell holds an index into the string table.
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? '-1');
        value = sharedStrings[index] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(content);
      } else if (type === 'str') {
        // A formula's cached result. The formula itself is never evaluated.
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? '');
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(content) ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        value = '';
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? '');
      }

      while (cells.length < column) cells.push('');
      cells[column] = value.slice(0, LIMITS.maxCellLength);
    }

    rows.push({ rowNumber, cells });
  }

  if (rows.length === 0) throw new SpreadsheetError('That .xlsx file has no rows in it.');

  // The sheet already states each row's number; it travels with the row.
  return toTable(rows, null, truncated);
}

/** `A` → 0, `Z` → 25, `AA` → 26. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const char of reference) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function readSharedStrings(entries: Map<string, Buffer>): string[] {
  const raw = entries.get('xl/sharedStrings.xml');
  if (!raw) return [];

  const xml = decode(raw);
  const strings: string[] = [];
  const pattern = /<si>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    strings.push(textOf(match[1] ?? '').slice(0, LIMITS.maxCellLength));
  }

  return strings;
}

/** All <t> runs joined — a styled cell is split across several of them. */
function textOf(fragment: string): string {
  const parts: string[] = [];
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) parts.push(match[1] ?? '');
  return unescapeXml(parts.join(''));
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function firstSheetPath(entries: Map<string, Buffer>): string | null {
  // workbook.xml lists sheets in tab order; the relationship file maps the
  // first one's id to its file. Falling back to sheet1.xml is close enough
  // when either is missing, and both are read as data, never as instructions.
  const workbook = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return null;

  const firstId = /<sheet\b[^>]*r:id="([^"]+)"/.exec(decode(workbook))?.[1];
  if (!firstId) return null;

  const target = new RegExp(`<Relationship[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(
    decode(rels),
  )?.[1];
  if (!target) return null;

  const normalised = target.replace(/^\/?(xl\/)?/, '');
  // Never follow a path out of the archive.
  if (normalised.includes('..')) return null;

  const candidate = `xl/${normalised}`;
  return entries.has(candidate) ? candidate : null;
}

function decode(buffer: Buffer): string {
  return buffer.toString('utf8');
}

// ==================================================================== ZIP ==

/**
 * Just enough ZIP to read named entries.
 *
 * Reads the central directory rather than scanning local headers, skips
 * anything that is not stored or deflated, refuses paths that escape the
 * archive, and caps total inflated bytes.
 */
function readZipEntries(bytes: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new SpreadsheetError('That file is not a readable .xlsx.');

  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);

  const entries = new Map<string, Buffer>();
  let inflated = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length) break;
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;

    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);

    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    // Only the handful of parts a worksheet needs, and never a traversal.
    if (name.includes('..') || name.startsWith('/')) continue;
    if (
      !/^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(
        name,
      )
    ) {
      continue;
    }

    inflated += uncompressedSize;
    if (inflated > LIMITS.maxInflatedBytes) {
      throw new SpreadsheetError('That file expands to far more than a member list should.');
    }

    if (localOffset + 30 > bytes.length) continue;
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) continue;

    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);

    try {
      entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    } catch {
      // A member that will not inflate is skipped, not fatal: the file may
      // still contain the worksheet we actually need.
    }
  }

  if (entries.size === 0) throw new SpreadsheetError('That file is not a readable .xlsx.');
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // It is at the end, after a comment of up to 64 KB.
  const from = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= from; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ================================================================== shared ==

/**
 * Turns numbered records into a table.
 *
 * Each record carries the row number it had in the file, and that number
 * travels with it rather than being recomputed from its position afterwards.
 * Recomputing it is wrong the moment a blank row is dropped — and the number
 * exists precisely so someone can be told "row 6 of your spreadsheet is
 * missing a phone number" and find it.
 */
function toTable(
  records: Array<{ rowNumber: number; cells: string[] }>,
  sheetName: string | null,
  truncated: boolean,
): SheetTable {
  // Skip leading blank lines — a spreadsheet often opens with a title row.
  const headerIndex = records.findIndex((record) =>
    record.cells.some((cell) => cell.trim().length > 0),
  );
  if (headerIndex < 0) throw new SpreadsheetError('That file has no rows in it.');

  const headers = (records[headerIndex]?.cells ?? [])
    .slice(0, LIMITS.maxColumns)
    .map((cell) => cell.trim());

  const rows = records
    .slice(headerIndex + 1)
    .map((record) => ({
      rowNumber: record.rowNumber,
      cells: record.cells.slice(0, LIMITS.maxColumns).map((cell) => cell.trim()),
    }))
    .filter((row) => row.cells.some((cell) => cell.length > 0));

  return { headers, rows, sheetName, truncated };
}

export const SPREADSHEET_LIMITS = LIMITS;
