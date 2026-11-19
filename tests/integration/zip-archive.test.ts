/**
 * The archive has to open.
 *
 * A hand-rolled or mis-wired ZIP that Excel refuses is a silent, total
 * failure of the export: every test above can pass while the file a gym
 * downloads is unusable. So this suite writes a real archive to disk and
 * opens it with an independent implementation — Python's `zipfile`, which
 * follows the same specification Excel and Finder do — rather than reading
 * it back with the library that wrote it.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { zipStream, exportFilename } from '../../apps/web/lib/zip-stream';
import type { ExportFile } from '@gym/core';

function fileOf(name: string, lines: string[]): ExportFile {
  return {
    name,
    contents: (async function* () {
      for (const line of lines) yield `${line}\r\n`;
    })(),
  };
}

async function writeArchive(files: ExportFile[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  const path = join(dir, 'export.zip');

  await pipeline(
    Readable.fromWeb(zipStream(files) as never),
    createWriteStream(path),
  );

  return path;
}

interface Inspection {
  names: string[];
  /** Whole contents, for the small files a test wants to read. */
  contents: Record<string, string>;
  /** Line count and first/last line, for files too big to pipe back. */
  shapes: Record<string, { lines: number; first: string; last: string }>;
  ok: boolean;
}

/**
 * Opens the archive with Python's zipfile and reports what it found.
 *
 * An independent implementation on purpose: reading the archive back with
 * yazl would prove only that yazl agrees with itself. Python's zipfile
 * follows the same specification Excel, Finder and File Explorer do.
 *
 * Contents come back whole only for small files. The first version returned
 * everything, and a 2MB CSV overflowed execFileSync's output buffer — the
 * archive was fine, the test harness was not.
 */
function inspect(path: string): Inspection {
  // The script lives in a file rather than a template literal: embedded in
  // one, its `"\r\n"` was turned into a real line break before Python ever
  // saw it, and every test failed on a syntax error in a string.
  const output = execFileSync('python3', ['-I', 'tests/support/inspect-zip.py', path], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(output);
}

describe('the archive a gym downloads', () => {
  it('opens in an implementation that did not write it', async () => {
    const path = await writeArchive([
      fileOf('members.csv', ['"memberCode","firstName"', '"M00001","Asha"']),
      fileOf('payments.csv', ['"receiptCode","amount"', '"RCP/2026-27/00001","1500.00"']),
      fileOf('README.txt', ['Data export']),
    ]);

    const archive = inspect(path);

    expect(archive.ok, 'the archive passes its own CRC checks').toBe(true);
    expect(archive.names.sort()).toEqual(['README.txt', 'members.csv', 'payments.csv']);
    expect(archive.contents['members.csv']).toContain('"M00001","Asha"');
    expect(archive.contents['payments.csv']).toContain('RCP/2026-27/00001');
  });

  it('carries the byte order mark Excel needs for Indian names', async () => {
    const path = await writeArchive([
      fileOf('members.csv', ['"firstName"', '"आशा"', '"ਅਮਨ"', '"அஷா"']),
    ]);

    const archive = inspect(path);

    // Read as utf-8-sig above, so the names survive the round trip — which
    // is what a BOM buys: without it Excel on Windows reads the file as the
    // system codepage and a Marathi member list arrives as mojibake.
    expect(archive.contents['members.csv']).toContain('आशा');
    expect(archive.contents['members.csv']).toContain('ਅਮਨ');
    expect(archive.contents['members.csv']).toContain('அஷா');
  });

  it('survives a file big enough to matter', async () => {
    // 60,000 rows: a four-year-old gym's attendance, roughly. The point is
    // that nothing here buffers the file, so this should be quick and flat
    // in memory rather than slow and heavy.
    const rows = ['"memberId","checkedInAt"'];
    for (let index = 0; index < 60_000; index += 1) {
      rows.push(`"member-${index}","2026-11-19T06:00:00.000Z"`);
    }

    const path = await writeArchive([fileOf('attendance.csv', rows)]);
    const archive = inspect(path);

    expect(archive.ok).toBe(true);
    // 60,001 written lines plus the trailing empty one after the last CRLF.
    expect(archive.shapes['attendance.csv']!.lines).toBe(60_002);
    expect(archive.shapes['attendance.csv']!.first).toBe('"memberId","checkedInAt"');
    expect(archive.shapes['attendance.csv']!.last).toContain('"member-59999"');
  });

  it('names the file so somebody can find it again', () => {
    const name = exportFilename('Iron Temple Fitness');

    expect(name).toMatch(/^iron-temple-fitness-export-\d{4}-\d{2}-\d{2}\.zip$/);
    // A gym name that is all punctuation still produces a usable filename.
    expect(exportFilename('!!!')).toMatch(/^gym-export-/);
    expect(exportFilename('Gym', 'my-data')).toContain('-my-data-');
  });
});
