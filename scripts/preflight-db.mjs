#!/usr/bin/env node
/**
 * Prove a production database is actually safe to point this application at.
 *
 *   node scripts/preflight-db.mjs
 *
 * Reads DATABASE_URL, DIRECT_DATABASE_URL and JOBS_DATABASE_URL and checks
 * the things that decide whether one gym can read another gym's records.
 * Run it against the managed database BEFORE the first deploy, and again
 * after any change to roles or migrations. Read-only: it writes nothing.
 *
 * Why this exists separately from the isolation test suite
 * -------------------------------------------------------
 * The suite runs against a database we built ourselves, where the three
 * roles were created exactly as intended. A managed provider creates roles
 * its own way, and the most dangerous difference does not show up in any
 * policy, any migration or any application code.
 *
 * BYPASSRLS does not leak through role membership — a role that merely
 * belongs to a BYPASSRLS role still sees nothing. But it can `SET ROLE` to
 * that role, and then it sees everything. Verified against PostgreSQL 16: a
 * member of a BYPASSRLS role read 0 rows from a FORCE-RLS table with a
 * deny-all policy, and read every row one `SET ROLE` later.
 *
 * Neon grants `neon_superuser` — which carries BYPASSRLS — to every role
 * created through its console, API or CLI. Create the application's role
 * that way and `rolbypassrls` on the role itself is still false, every
 * policy is present and correct, the isolation suite passes, and the
 * application is one statement away from reading every gym in the database.
 *
 * So CHECK 2 asks what the role can BECOME, not what it is.
 */

import { execFileSync } from 'node:child_process';

const REQUIRED = ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'JOBS_DATABASE_URL'];
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Set these first: ${missing.join(', ')}`);
  process.exit(1);
}

// The lowest number of tenant tables this schema has ever had. A managed
// database showing fewer has not had every migration applied, whatever
// _prisma_migrations claims.
const MIN_TENANT_TABLES = 75;

function parsed(connection) {
  const u = new URL(connection);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

/** One query, one row per line, columns separated by | — no credentials echoed. */
function ask(connection, sql) {
  const c = parsed(connection);
  const out = execFileSync(
    'psql',
    ['-h', c.host, '-p', c.port, '-U', c.user, '-d', c.database,
     '-v', 'ON_ERROR_STOP=1', '-At', '-F', '|', '-c', sql],
    { env: { ...process.env, PGPASSWORD: c.password }, encoding: 'utf8' },
  );
  return out.trim() === '' ? [] : out.trim().split('\n').map((line) => line.split('|'));
}

const failures = [];
const notes = [];

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures.push({ name, message: error.message.split('\n')[0] });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n')[0]}`);
  }
}

const APP = process.env.DATABASE_URL;
const OWNER = process.env.DIRECT_DATABASE_URL;
const JOBS = process.env.JOBS_DATABASE_URL;

console.log('\nPreflight — production database\n');

check('reachable, and a supported server version', () => {
  const [[version]] = ask(APP, 'SHOW server_version');
  const major = Number.parseInt(version, 10);
  if (Number.isNaN(major) || major < 14) {
    throw new Error(`PostgreSQL ${version}; this schema needs 14 or newer`);
  }
  return `PostgreSQL ${version}`;
});

check('the three connection strings are three different roles', () => {
  const users = [APP, OWNER, JOBS].map((url) => ask(url, 'SELECT current_user')[0][0]);
  const unique = new Set(users);
  if (unique.size !== 3) {
    throw new Error(
      `got ${unique.size} distinct role(s) across the three URLs: ${users.join(', ')}. ` +
        'One role doing all three jobs means the application runs with whatever ' +
        'the migration or the cron role was given.',
    );
  }
  return users.join(', ');
});

check('the application role is neither superuser nor BYPASSRLS', () => {
  const [[isSuper, bypasses]] = ask(
    APP,
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  if (isSuper === 't') throw new Error('the application role is a superuser; RLS does not apply to it');
  if (bypasses === 't') throw new Error('the application role has BYPASSRLS; every policy is decoration');
  return 'rolsuper=false, rolbypassrls=false';
});

// CHECK 2. See the header. This is the one a managed provider fails.
check('the application role cannot BECOME a role that bypasses RLS', () => {
  const rows = ask(
    APP,
    `SELECT r.rolname FROM pg_roles r
      WHERE (r.rolbypassrls OR r.rolsuper)
        AND r.rolname <> current_user
        AND pg_has_role(current_user, r.oid, 'MEMBER')`,
  );
  if (rows.length > 0) {
    const names = rows.map((r) => r[0]).join(', ');
    throw new Error(
      `the application role is a member of: ${names}. It can SET ROLE to any of ` +
        'them and read every tenant in the database. Create the application role ' +
        'with plain SQL (CREATE ROLE ... NOBYPASSRLS), never through a provider ' +
        'console that grants its own elevated role by default.',
    );
  }
  return 'no path to a BYPASSRLS or superuser role';
});

check('the jobs role does have BYPASSRLS', () => {
  const [[bypasses]] = ask(JOBS, 'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user');
  if (bypasses !== 't') {
    throw new Error(
      'the jobs role lacks BYPASSRLS. Cron, inbound webhooks and pg_dump all ' +
        'need it, and without it backups fail and scheduled work silently stops.',
    );
  }
  return 'rolbypassrls=true';
});

check('every tenant table has RLS enabled AND forced', () => {
  const rows = ask(
    JOBS,
    `SELECT c.relname, c.relforcerowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
  );
  if (rows.length < MIN_TENANT_TABLES) {
    throw new Error(
      `only ${rows.length} tables have RLS; expected at least ${MIN_TENANT_TABLES}. ` +
        'Migrations are probably not all applied.',
    );
  }
  const notForced = rows.filter((r) => r[1] !== 't').map((r) => r[0]);
  if (notForced.length > 0) {
    throw new Error(
      `RLS enabled but NOT forced on: ${notForced.join(', ')}. ` +
        'Without FORCE, the table owner reads straight past every policy.',
    );
  }
  return `${rows.length} tables, all forced`;
});

check('no RLS table was left without a policy', () => {
  const rows = ask(
    JOBS,
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policies p
                         WHERE p.schemaname = 'public' AND p.tablename = c.relname)`,
  );
  if (rows.length > 0) {
    throw new Error(
      `RLS on with no policy, so these deny everything to the application: ` +
        rows.map((r) => r[0]).join(', '),
    );
  }
  return 'none';
});

// Not an inspection of the catalogue — an actual read, as the application's
// own role, with no organization in context. A correct database returns
// nothing. A misconfigured one hands over the lot.
check('the application role, with no tenant in context, reads nothing', () => {
  const [[visible]] = ask(APP, 'SELECT count(*) FROM members');
  if (visible !== '0') {
    throw new Error(
      `read ${visible} member rows with no organization set. Row-level security ` +
        'is not in force for this role.',
    );
  }
  return '0 rows, as it must be';
});

check('migrations are all applied, and none failed', () => {
  const rows = ask(
    OWNER,
    `SELECT migration_name, (finished_at IS NULL) AS unfinished, rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations ORDER BY started_at`,
  );
  if (rows.length === 0) throw new Error('no migrations recorded; this database is empty');
  const broken = rows.filter((r) => r[1] === 't' || r[2] === 't').map((r) => r[0]);
  if (broken.length > 0) {
    throw new Error(`unfinished or rolled back: ${broken.join(', ')}`);
  }
  return `${rows.length} applied`;
});

check('connections are encrypted in transit', () => {
  const rows = ask(APP, 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  if (rows.length === 0 || rows[0][0] !== 't') {
    // Localhost is fine unencrypted; a remote managed database is not.
    const host = parsed(APP).host;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      notes.push('TLS not in use, but the database is local — fine for development.');
      return 'skipped (local database)';
    }
    throw new Error(
      `the connection to ${host} is not using TLS. Add sslmode=require to the ` +
        'connection string; member health declarations and staff salaries cross ' +
        'this link.',
    );
  }
  return 'TLS in use';
});

console.log('');
for (const note of notes) console.log(`note: ${note}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed. Do not deploy against this database.\n`);
  process.exit(1);
}

console.log('All checks passed. This database is safe to point the application at.\n');
