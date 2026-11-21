#!/usr/bin/env node
/**
 * Back the database up, and prove the backup can be restored.
 *
 *   node scripts/backup.mjs                    # take a backup
 *   node scripts/backup.mjs --verify           # take one, restore it, check it
 *   node scripts/backup.mjs --restore <file>   # restore into a scratch database
 *
 * A backup nobody has restored is a hope, not a backup. The commonest way to
 * lose a database is to discover, on the day it matters, that the dumps have
 * been failing silently for a month, or that they restore without the roles
 * and row-level security the application depends on — so the restore comes
 * back up with every gym able to read every other gym's data.
 *
 * `--verify` is the part that earns the word backup: it restores into a
 * throwaway database, counts the rows against the original, and checks that
 * row-level security came back ENABLED and FORCED on every table it was on.
 * It never touches the database it dumped.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const restoreIndex = args.indexOf('--restore');
const restoreFrom = restoreIndex === -1 ? null : args[restoreIndex + 1];

const OUT_DIR = process.env.BACKUP_DIR ?? 'backups';

/**
 * Two connections, for a reason worth knowing before the first backup.
 *
 * Every tenant table here has `FORCE ROW LEVEL SECURITY`, which applies to
 * the table's owner as well — that is the point of FORCE. During a dump no
 * organization is in context, so `current_org_id()` is NULL, the policy
 * denies, and **pg_dump refuses to run**: `query would be affected by
 * row-level security policy for table "attendance"`. It does not quietly
 * produce a dump with the rows missing, which is the one mercy here.
 *
 * So the dump must run as a role with BYPASSRLS. `gym_jobs` has it, for the
 * cron work. The restore must run as the owner, because it recreates tables,
 * policies and grants, which BYPASSRLS does not permit.
 *
 * Anybody who sets up a nightly `pg_dump` with the owner credentials — the
 * obvious thing to do — gets a backup that fails every night. If nobody is
 * reading the cron mail, they find out on the day they need it.
 */
const dumpUrl =
  process.env.BACKUP_DATABASE_URL ?? process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL;

// DIRECT_DATABASE_URL is the owner. DATABASE_URL is the application's own
// runtime role, which has neither DDL rights nor CREATEDB — using it for a
// restore gets "permission denied to create database", which is the right
// refusal for the wrong-looking reason.
const ownerUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;

if (!dumpUrl || !ownerUrl) {
  console.error(
    'Set DIRECT_DATABASE_URL (the owner, for restores) and JOBS_DATABASE_URL\n' +
      'or BACKUP_DATABASE_URL (a role with BYPASSRLS, for dumps).',
  );
  process.exit(1);
}

const url = ownerUrl;

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

const target = parsed(url);
const dumper = parsed(dumpUrl);

const env = { ...process.env, PGPASSWORD: target.password };
const dumpEnv = { ...process.env, PGPASSWORD: dumper.password };

function run(command, argv, options = {}) {
  return execFileSync(command, argv, {
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

// --------------------------------------------------------------- dump ---

function takeBackup() {
  mkdirSync(OUT_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(OUT_DIR, `${target.database}-${stamp}.dump`);

  // Custom format, not plain SQL: it restores selectively, in parallel, and
  // compresses. `--no-owner` so the dump restores under whatever role the
  // new host gives us rather than demanding the old one exist.
  try {
    execFileSync(
      'pg_dump',
      [
        '-h', dumper.host, '-p', dumper.port, '-U', dumper.user,
        '-d', dumper.database,
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--file', file,
      ],
      { env: dumpEnv, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`;

    if (/row-level security/i.test(detail)) {
      console.error(
        '\npg_dump was refused by row-level security.\n\n' +
          `The role it used (${dumper.user}) does not have BYPASSRLS, and every\n` +
          'tenant table here has FORCE ROW LEVEL SECURITY — which applies to the\n' +
          'owner too. Dump as a role that has BYPASSRLS:\n\n' +
          '  ALTER ROLE gym_jobs BYPASSRLS;   -- already set by the RLS migration\n\n' +
          'and point BACKUP_DATABASE_URL (or JOBS_DATABASE_URL) at it.\n',
      );
      process.exit(1);
    }

    console.error(`\npg_dump failed:\n${detail.slice(0, 600)}`);
    process.exit(1);
  }

  const size = statSync(file).size;
  if (size < 1024) {
    // A dump of a populated database is never this small. Failing loudly
    // here is the whole point: a silently empty backup is worse than none,
    // because somebody stops worrying.
    console.error(`Refusing: the dump is only ${size} bytes. Something went wrong.`);
    process.exit(1);
  }

  console.log(`Backup written: ${file} (${(size / 1_048_576).toFixed(1)} MB)`);
  return file;
}

// ------------------------------------------------------------ restore ---

/**
 * Refreshes the statistics this comparison reads.
 *
 * `n_live_tup` is an estimate maintained by autovacuum, and it is 0 for a
 * table that has rows but has not been analysed yet — so without this the
 * verification would skip exactly the tables most recently written to and
 * pass by not looking. Analysed table by table rather than a bare ANALYZE,
 * which tries the system catalogues and prints a page of warnings about
 * them.
 */
function refreshStatistics(database) {
  run('psql', [
    '-h', target.host, '-p', target.port, '-U', target.user,
    '-d', database, '-q', '-c',
    `DO $$
       DECLARE t record;
       BEGIN
         FOR t IN SELECT quote_ident(tablename) AS name FROM pg_tables
                   WHERE schemaname = 'public'
         LOOP
           EXECUTE 'ANALYZE public.' || t.name;
         END LOOP;
       END $$;`,
  ]);
}

/**
 * Row counts for every table, to compare before and after.
 *
 * Read from pg_stat_user_tables rather than by counting: the statistics
 * collector's view is not filtered by row-level security, so this works as
 * the owner. A `SELECT count(*)` here would return 0 for every tenant table
 * — FORCE ROW LEVEL SECURITY applies to the owner too — and the comparison
 * would pass by being uniformly wrong.
 */
function census(database) {
  const output = run('psql', [
    '-h', target.host, '-p', target.port, '-U', target.user,
    '-d', database, '-tAF,', '-c',
    `SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname`,
  ]);

  const counts = {};
  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [name, rows] = line.split(',');
    counts[name] = Number(rows);
  }
  return counts;
}

/** Which tables have RLS on, and forced. The thing a restore must not lose. */
function rlsState(database) {
  const output = run('psql', [
    '-h', target.host, '-p', target.port, '-U', target.user,
    '-d', database, '-tAF,', '-c',
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  ]);

  const state = {};
  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const [name, enabled, forced, policies] = line.split(',');
    state[name] = { enabled: enabled === 't', forced: forced === 't', policies: Number(policies) };
  }
  return state;
}

function restoreInto(file, database) {
  // Dropped and recreated so a restore is never layered on top of whatever
  // was there — a half-restored database that looks complete is the worst
  // outcome available.
  run('psql', [
    '-h', target.host, '-p', target.port, '-U', target.user, '-d', 'postgres',
    '-c', `DROP DATABASE IF EXISTS "${database}"`,
  ]);
  run('psql', [
    '-h', target.host, '-p', target.port, '-U', target.user, '-d', 'postgres',
    '-c', `CREATE DATABASE "${database}"`,
  ]);

  // pg_restore exits non-zero on warnings that do not matter (an extension
  // comment, a missing role), so its output is read rather than its code.
  let output;
  try {
    output = run('pg_restore', [
      '-h', target.host, '-p', target.port, '-U', target.user,
      '-d', database,
      '--no-owner',
      '--no-privileges',
      file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const fatal = output
      .split('\n')
      .filter((line) => /error:/i.test(line))
      .filter((line) => !/does not exist|must be owner|already exists/i.test(line));

    if (fatal.length > 0) {
      console.error('Restore failed:\n' + fatal.slice(0, 10).join('\n'));
      process.exit(1);
    }
  }

  return output;
}

// --------------------------------------------------------------- main ---

if (restoreFrom) {
  if (!existsSync(restoreFrom)) {
    console.error(`No such file: ${restoreFrom}`);
    process.exit(1);
  }
  const scratch = `${target.database}_restore_check`;
  console.log(`Restoring ${restoreFrom} into ${scratch} …`);
  restoreInto(restoreFrom, scratch);
  console.log(`Restored. Inspect it with: psql -d ${scratch}`);
  process.exit(0);
}

const file = takeBackup();

if (!verify) {
  console.log('\nNot verified. Run with --verify to prove it restores.');
  process.exit(0);
}

const scratch = `${target.database}_restore_check`;
console.log(`\nVerifying by restoring into ${scratch} …`);

refreshStatistics(target.database);
const before = census(target.database);
const beforeRls = rlsState(target.database);

restoreInto(file, scratch);

// A freshly restored database has no statistics at all.
refreshStatistics(scratch);

const after = census(scratch);
const afterRls = rlsState(scratch);

const problems = [];

// Row counts, on the tables that have rows worth counting.
for (const [table, rows] of Object.entries(before)) {
  if (rows === 0) continue;
  const restored = after[table];
  if (restored === undefined) {
    problems.push(`${table}: missing from the restore entirely`);
    continue;
  }
  // Estimates, so a small drift is expected; a real loss is not.
  if (restored < rows * 0.9) {
    problems.push(`${table}: ${rows} rows became ${restored}`);
  }
}

// The part that matters most, and the part a plain "did it restore" check
// misses: a restore without row-level security comes back up with every gym
// able to read every other gym's data.
for (const [table, state] of Object.entries(beforeRls)) {
  if (!state.enabled) continue;
  const restored = afterRls[table];
  if (!restored?.enabled) problems.push(`${table}: row-level security is OFF after restore`);
  else if (!restored.forced) problems.push(`${table}: row-level security is not FORCED after restore`);
  else if (restored.policies < state.policies) {
    problems.push(`${table}: ${state.policies} policies became ${restored.policies}`);
  }
}

const tablesWithRls = Object.values(afterRls).filter((state) => state.enabled && state.forced).length;
const policies = Object.values(afterRls).reduce((sum, state) => sum + state.policies, 0);

run('psql', [
  '-h', target.host, '-p', target.port, '-U', target.user, '-d', 'postgres',
  '-c', `DROP DATABASE IF EXISTS "${scratch}"`,
]);

if (problems.length > 0) {
  console.error(`\nThe backup does NOT restore cleanly:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nDo not rely on this backup.\n');
  process.exit(1);
}

const tables = Object.keys(before).filter((table) => before[table] > 0).length;
console.log(
  `\nVerified. ${tables} populated tables restored with their rows, ` +
    `and row-level security came back enabled and forced on ${tablesWithRls} tables ` +
    `with ${policies} policies.\n`,
);
