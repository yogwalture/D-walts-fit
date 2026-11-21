#!/usr/bin/env node
/**
 * Refuse to ship a secret.
 *
 *   node scripts/scan-secrets.mjs            # the files git is tracking
 *   node scripts/scan-secrets.mjs --staged   # only what is about to commit
 *   node scripts/scan-secrets.mjs --history  # every file ever added
 *
 * This exists because "never put credentials in GitHub" is a rule somebody
 * has to remember, and the one time it is forgotten is the time it matters.
 * A key in a public repository is compromised the moment it is pushed —
 * removing it later changes nothing, because the history keeps it and the
 * scrapers were there first.
 *
 * Exits non-zero on a finding, so it can gate a commit, a push or a deploy.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = args.includes('--staged')
  ? 'staged'
  : args.includes('--history')
    ? 'history'
    : 'tracked';

/**
 * Each rule is a thing that is a secret in itself, not a thing that looks
 * like one. `password` as a word appears legitimately all over a codebase
 * that handles passwords; a 32-byte base64 key assigned to ENCRYPTION_KEY
 * does not.
 */
const RULES = [
  {
    name: 'Razorpay live key id',
    pattern: /rzp_live_[A-Za-z0-9]{10,}/,
    why: 'A live Razorpay key id, which pairs with a secret to move real money.',
  },
  {
    name: 'Razorpay test key id',
    // Allowed where it is plainly a fixture; flagged anywhere else.
    pattern: /rzp_test_(?!XXXX|FakeKey|AbCdEf)[A-Za-z0-9]{12,}/,
    why: 'A real Razorpay test key. Test keys still identify an account.',
  },
  {
    name: 'Stripe secret key',
    pattern: /sk_(live|test)_[A-Za-z0-9]{16,}/,
    why: 'A Stripe secret key.',
  },
  {
    name: 'AWS access key id',
    pattern: /AKIA[0-9A-Z]{16}/,
    why: 'An AWS access key id.',
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    why: 'A private key.',
  },
  {
    name: 'PostgreSQL URL with a password',
    // postgres://user:something@host — a URL carrying real credentials.
    pattern: /postgres(?:ql)?:\/\/[^\s:@/]+:(?!password\b|changeme\b|postgres\b|REPLACE)[^\s:@/]{6,}@/,
    why: 'A database URL with a real password in it.',
  },
  {
    name: 'Meta/WhatsApp access token',
    // Requires an assignment or query-parameter context. The bare `EAA…`
    // prefix on its own matched the base64-inlined PDF fonts, which are a
    // megabyte of legitimate data — a scanner that cries wolf is a scanner
    // somebody switches off.
    pattern:
      /(?:access[_-]?token|ACCESS_TOKEN|WHATSAPP_TOKEN)\s*[=:]\s*["']?EAA[A-Za-z0-9]{40,}/,
    why: 'A Meta Graph API access token.',
  },
  {
    name: 'assigned encryption key',
    // ENCRYPTION_KEY="<32 bytes of base64>" — the real thing, not a comment.
    pattern: /ENCRYPTION_KEY\s*=\s*["']?[A-Za-z0-9+/]{40,}={0,2}["']?/,
    why: 'A 32-byte encryption key. Every stored integration credential is encrypted with it.',
  },
  {
    name: 'assigned cron or webhook secret',
    pattern: /(?:CRON_SECRET|RAZORPAY_WEBHOOK_SECRET|RAZORPAY_KEY_SECRET)\s*=\s*["']?[A-Za-z0-9_\-+/]{16,}["']?/,
    why: 'A shared secret that authorises a privileged endpoint.',
  },
];

/**
 * Files whose whole job is to show the shape of a secret without being one.
 *
 * Deliberately four exact paths rather than a pattern. The scanner's own
 * test file has to contain a planted example of every rule or it cannot
 * prove the rules work — and it shipped once in a state where it passed
 * only while untracked, then failed the moment it was committed, which is
 * how this exception came to be written.
 *
 * Nothing here holds a working credential: the examples are documentation
 * values (AWS's own `AKIAIOSFODNN7EXAMPLE`, among others). Adding to this
 * list is how a real secret eventually gets through, so a test asserts it
 * stays this short.
 */
const ALLOWED_PATHS = [
  /^\.env\.example$/,
  /^docs\/.*\.md$/,
  /^scripts\/scan-secrets\.mjs$/,
  /^tests\/integration\/secret-scan\.test\.ts$/,
];

/** Exposed so the test can assert the exception list has not grown. */
export const allowedPathCount = ALLOWED_PATHS.length;

/** Binary and generated things there is no point reading. */
const SKIP_PATHS = [
  /^pnpm-lock\.yaml$/,
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|otf|mp4)$/i,
  /^packages\/db\/prisma\/migrations\//,
];

function git(...argv) {
  return execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function filesToScan() {
  if (mode === 'staged') {
    return git('diff', '--cached', '--name-only', '--diff-filter=ACM').split('\n').filter(Boolean);
  }
  if (mode === 'history') {
    return [
      ...new Set(
        git('log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:')
          .split('\n')
          .filter(Boolean),
      ),
    ];
  }
  return git('ls-files').split('\n').filter(Boolean);
}

/**
 * In history mode a path may no longer exist on disk, so the content is read
 * from the commit that added it. A secret removed in a later commit is still
 * a secret anybody can `git show`.
 */
function contentOf(path) {
  if (mode !== 'history') {
    try {
      if (statSync(path).size > 2 * 1024 * 1024) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  try {
    const commits = git('log', '--all', '--format=%H', '--diff-filter=A', '--', path)
      .split('\n')
      .filter(Boolean);
    return commits.map((commit) => git('show', `${commit}:${path}`)).join('\n');
  } catch {
    return null;
  }
}

const findings = [];

for (const path of filesToScan()) {
  if (SKIP_PATHS.some((skip) => skip.test(path))) continue;
  if (ALLOWED_PATHS.some((allowed) => allowed.test(path))) continue;

  const content = contentOf(path);
  if (!content) continue;

  for (const rule of RULES) {
    const match = rule.pattern.exec(content);
    if (!match) continue;

    const line = content.slice(0, match.index).split('\n').length;
    findings.push({ path, line, rule: rule.name, why: rule.why });
  }
}

// A tracked .env is its own finding: whatever is in it today, it is the file
// every credential ends up in tomorrow.
const tracked = mode === 'staged' ? filesToScan() : git('ls-files').split('\n');
for (const path of tracked) {
  if (/(^|\/)\.env$|(^|\/)\.env\.(?!example)/.test(path)) {
    findings.push({
      path,
      line: 1,
      rule: 'tracked environment file',
      why: 'Environment files hold every credential the app has. This one is in git.',
    });
  }
}

if (findings.length === 0) {
  console.log(`No secrets found (${mode}).`);
  process.exit(0);
}

console.error(`\nRefusing to ship: ${findings.length} possible secret(s) found.\n`);
for (const finding of findings) {
  console.error(`  ${finding.path}:${finding.line}`);
  console.error(`    ${finding.rule} — ${finding.why}\n`);
}
console.error(
  'If one of these is a placeholder, make it obviously fake rather than\n' +
    'adding an exception. If one is real: rotate it at the provider first,\n' +
    'then remove it. A pushed key is compromised, and deleting it later\n' +
    'does not un-push it.\n',
);
process.exit(1);
