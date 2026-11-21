/**
 * The scanner has to catch things.
 *
 * A secret scanner that passes everything is worse than none: it produces a
 * green tick that somebody trusts. So each rule is tested by planting the
 * thing it is supposed to find in a scratch repository and checking the
 * scanner refuses — and by planting the near-misses that have to stay
 * allowed, because the first version of this flagged a megabyte of
 * base64-inlined PDF fonts as a Meta token, and a scanner that cries wolf
 * gets switched off.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scanner = resolve('scripts/scan-secrets.mjs');
let repo: string;

/** A scratch git repository, because the scanner reads what git tracks. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

/** Writes a file, tracks it, and returns what the scanner says. */
function scan(files: Record<string, string>): { ok: boolean; output: string } {
  rmSync(repo, { recursive: true, force: true });
  repo = freshRepo();

  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });

  try {
    const output = execFileSync('node', [scanner], { cwd: repo, encoding: 'utf8' });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

beforeAll(() => {
  repo = freshRepo();
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('what the scanner refuses', () => {
  it('a live Razorpay key', () => {
    const result = scan({ 'config.ts': "const key = 'rzp_live_AbCdEf123456';" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Razorpay live key');
  });

  it('a Stripe secret key', () => {
    const result = scan({ 'pay.ts': "stripe('sk_live_51Habcdefghijklmnop');" });
    expect(result.ok).toBe(false);
  });

  it('an AWS access key id', () => {
    const result = scan({ 'deploy.sh': 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' });
    expect(result.ok).toBe(false);
  });

  it('a private key', () => {
    const result = scan({
      'cert.txt': '-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAK\n-----END RSA PRIVATE KEY-----',
    });
    expect(result.ok).toBe(false);
  });

  it('a database URL carrying a real password', () => {
    const result = scan({
      'notes.txt': 'postgres://gym_app:Xk92mQp4vRt8@db.example.com:5432/gym_cloud',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('database URL');
  });

  it('an encryption key that is actually assigned', () => {
    const result = scan({
      'env.sh': 'ENCRYPTION_KEY="aGVsbG8gdGhpcyBpcyBhIHJlYWwgbG9va2luZyBrZXkgdmFsdWU9"',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('encryption key');
  });

  it('a cron secret that is actually assigned', () => {
    const result = scan({ 'env.sh': 'CRON_SECRET=9f3b2c7d8e1a4b6c5d0e2f1a' });
    expect(result.ok).toBe(false);
  });

  it('a Meta access token where one is assigned', () => {
    const result = scan({
      'wa.ts': `const access_token = 'EAA${'x'.repeat(60)}';`,
    });
    expect(result.ok).toBe(false);
  });

  it('a tracked .env, whatever happens to be in it today', () => {
    const result = scan({ '.env': 'PORT=3000\n' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('environment file');
  });

  it('a tracked .env.production, by the same reasoning', () => {
    const result = scan({ '.env.production': 'NODE_ENV=production\n' });
    expect(result.ok).toBe(false);
  });
});

describe('what the scanner allows', () => {
  it('an .env.example full of placeholder shapes', () => {
    const result = scan({
      '.env.example': [
        'DATABASE_URL="postgresql://gym_app:password@localhost:5432/gym_cloud"',
        'RAZORPAY_KEY_ID="rzp_test_XXXXXXXXXXXX"',
        'ENCRYPTION_KEY="generate with: openssl rand -base64 32"',
      ].join('\n'),
    });
    expect(result.ok, result.output).toBe(true);
  });

  it('a megabyte of base64 that is not a token', () => {
    // The real false positive: the inlined PDF fonts. `EAA…` appears inside
    // ordinary base64 all the time.
    const blob = `export const font = '${'EAA' + 'QUJDRA'.repeat(20_000)}';`;
    const result = scan({ 'fonts.ts': blob });
    expect(result.ok, result.output).toBe(true);
  });

  it('code that talks about secrets without containing one', () => {
    const result = scan({
      'gateway.ts': [
        "if (!/^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(keyId)) throw new Error('bad key');",
        "const hint = 'Expected rzp_test_… or rzp_live_…';",
        'const keySecret = process.env.RAZORPAY_KEY_SECRET;',
        'const password = await hash(input.password);',
      ].join('\n'),
    });
    expect(result.ok, result.output).toBe(true);
  });

  it('a placeholder database URL nobody could connect with', () => {
    const result = scan({
      'docs.txt': 'postgresql://user:REPLACE_ME@host:5432/db',
    });
    expect(result.ok, result.output).toBe(true);
  });
});

describe('the exception list', () => {
  /**
   * This test exists because of a mistake in the commit that added the
   * scanner. Its own fixtures trip every rule — they have to — so the
   * scanner has to allow this one file. That exception was added only after
   * the suite went red: the scanner had run clean before the commit, when
   * this file was still untracked, and failed the moment it was committed.
   *
   * An exception list is how a real secret eventually gets through, so this
   * pins its size. If it grows, somebody has to come here and say why.
   */
  it('is four paths, and no more', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const source = readFileSync('scripts/scan-secrets.mjs', 'utf8');
    const block = source.slice(
      source.indexOf('const ALLOWED_PATHS = ['),
      source.indexOf('];', source.indexOf('const ALLOWED_PATHS = [')),
    );
    const entries = block.match(/\/\^/g) ?? [];

    expect(entries).toHaveLength(4);
    expect(block).toContain('env\\.example');
    expect(block).toContain('secret-scan\\.test\\.ts');
  });

  it('does not allow a whole directory of source', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const source = readFileSync('scripts/scan-secrets.mjs', 'utf8');
    const block = source.slice(
      source.indexOf('const ALLOWED_PATHS = ['),
      source.indexOf('];', source.indexOf('const ALLOWED_PATHS = [')),
    );

    // docs/*.md is the one wildcard, and prose is not where keys live.
    for (const pattern of ['packages/', 'apps/', 'src/', '.*\\.ts$']) {
      expect(block).not.toContain(pattern);
    }
  });
});

describe('this repository', () => {
  it('has no secret in anything git tracks', () => {
    const output = execFileSync('node', [scanner], { encoding: 'utf8' });
    expect(output).toContain('No secrets found');
  });

  /**
   * History matters separately. A key committed and then deleted is still
   * readable with `git show`, and a pushed key is compromised whatever the
   * current tree says.
   */
  it('and none in anything it ever tracked', () => {
    const output = execFileSync('node', [scanner, '--history'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(output).toContain('No secrets found');
  });
});
