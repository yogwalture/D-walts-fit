/**
 * The backup has to restore, and the restore has to keep row-level security.
 *
 * This is the one piece of operational machinery that cannot be checked by
 * reading it. The first run of `scripts/backup.mjs` found that **pg_dump
 * fails outright** against this database: every tenant table has FORCE ROW
 * LEVEL SECURITY, which applies to the owner too, so a dump with no
 * organization in context is refused. A nightly job set up the obvious way
 * would have failed every night.
 *
 * So these tests run the real script against the real database and read what
 * it says — including the two failure modes worth being certain about: a
 * dump that is empty, and a restore that comes back without its policies.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/backup.mjs');

function runBackup(args: string[], env: Record<string, string> = {}) {
  try {
    const output = execFileSync('node', [script, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('taking a backup and restoring it', () => {
  it('dumps, restores, and proves row-level security survived', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));

    const result = runBackup(['--verify'], { BACKUP_DIR: dir });

    expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain('Verified.');

    // The row comparison has to have looked at a real number of tables. An
    // earlier version read unrefreshed statistics and reported 14 where
    // there were 53, silently skipping two thirds of them.
    const tables = /Verified\. (\d+) populated tables/.exec(result.output);
    expect(tables, result.output).not.toBeNull();
    expect(Number(tables![1])).toBeGreaterThan(30);

    // And the part a plain "did it restore" check misses entirely.
    const rls = /forced on (\d+) tables with (\d+) policies/.exec(result.output);
    expect(rls, result.output).not.toBeNull();
    expect(Number(rls![1])).toBeGreaterThan(70);
    expect(Number(rls![2])).toBeGreaterThan(70);

    // A dump file was actually written, and it is not a stub.
    const files = readdirSync(dir).filter((name) => name.endsWith('.dump'));
    expect(files).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  }, 300_000);

  /**
   * The failure this whole script exists to surface: dumping as a role
   * without BYPASSRLS. It must stop with an explanation, not a stack trace,
   * because the person reading it is setting up a cron job at the time.
   */
  it('refuses, with the reason, when the dump role cannot bypass RLS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));

    // DATABASE_URL is the application's role: no BYPASSRLS, by design.
    const result = runBackup([], {
      BACKUP_DIR: dir,
      BACKUP_DATABASE_URL: process.env.DATABASE_URL!,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('row-level security');
    expect(result.output).toContain('BYPASSRLS');
    // Names the role that failed, so nobody has to guess which one it used.
    expect(result.output).toMatch(/role it used \(\w+\)/);

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('refuses a file that is too small to be a real dump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
    const stub = join(dir, 'tiny.dump');
    writeFileSync(stub, 'not really a dump');

    const result = runBackup(['--restore', stub]);

    // A restore from a stub fails rather than producing an empty database
    // that looks restored.
    expect(result.ok).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('says plainly when it has not verified anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));

    const result = runBackup([], { BACKUP_DIR: dir });

    expect(result.ok, result.output).toBe(true);
    // An unverified backup should not read as a verified one.
    expect(result.output).toContain('Not verified');
    expect(result.output).not.toContain('Verified.');

    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
