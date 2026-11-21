# Deploying to Hostinger

Verified against the live account on 17 November 2026.

---

## The account, as it actually is

| | |
| --- | --- |
| Plan | `hostinger_business`, active since August 2023 |
| Order | 200717935 |
| Account | `u203688121` |
| Websites | 15 |
| Node.js apps already running | 4 — genadhar.com, nutraatoz.com, nishisdental.com, gajananhospitalccc.com |
| WordPress | 2 — infymart.in, naturonics.in |
| Builder sites | 3 |
| Other / static | 6 |

**Read this before deploying.** Hostinger documents the Business plan as
supporting 5 Node.js websites against a shared budget of 120 processes. Four
are in use. Deploying the gym platform takes the last slot and shares that
process budget with four live businesses. For Phase 1 — an almost-idle app
proving the pipeline — that is fine. For a production SaaS under morning
check-in load it is not, and the risk lands on Genadhar, NutraAtoZ, Nishi's
Dental and the hospital site as much as on this one.

**Plan the move to a VPS for the end of Phase 4, when your gym goes live.**

---

## What runs where

| Component | Host |
| --- | --- |
| Next.js application | Hostinger Business, as a Node.js Web App |
| Marketing site | Same deployment |
| Scheduled jobs | Hostinger cron → `/api/cron/*` over HTTPS |
| **PostgreSQL** | **External managed provider — not available on Hostinger Web or Cloud plans** |
| Uploads, invoice PDFs | S3-compatible object storage (Cloudflare R2) |
| Video | Cloudflare Stream |

Nothing persistent lives on the hosting plan. A deploy replaces the
application directory, so a file written at runtime is not safe there — which
is also why 600,000 inodes stay free.

---

## The repository

| | |
| --- | --- |
| Remote | `https://github.com/yogwalture/D-walts-fit` |
| Default branch | `main` |
| CI | `.github/workflows/ci.yml` — secret scan, types, lint, isolation suite, full suite |
| Deploy trigger | push to `main`, and only after CI is green |

Secrets to set in **Settings → Secrets and variables → Actions** before the
first push to `main`, or the deploy job fails on its first step:

| Secret | What it is |
| --- | --- |
| `DIRECT_DATABASE_URL` | The owner connection, used by `prisma migrate deploy` and nothing else |

Create a GitHub **environment** named `production` and require your own
review on it. The deploy job is bound to that environment, so a push to
`main` applies migrations to the production database only once a human has
approved that run. Without the environment the job runs unattended, which is
not what you want pointed at a live database.

Everything else — the application's own environment variables — belongs in
the Hostinger deploy configuration, not in GitHub and not in the repository.
CI builds against a throwaway PostgreSQL service with throwaway secrets
written in plain sight in the workflow file; they are deliberately worthless.

---

## Platform constraints the application is built around

| Constraint | Consequence |
| --- | --- |
| No PostgreSQL | Database is external, reached over TLS |
| No background workers — they stop on every deploy or restart | All deferred work is cron-triggered HTTP endpoints, idempotent and windowed |
| 120-second request timeout | Bulk import, bulk messaging and report generation are chunked across cron ticks |
| No inbound WebSockets | Kiosk and dashboards poll; outbound webhooks are unaffected |
| No Redis, Docker or custom ports | Postgres-backed caching and rate limiting; no container in the build |
| Node.js only — no Python, no Bun | Everything in TypeScript |

---

## Before the first deploy

- [ ] Confirm a free Node.js Web App slot in hPanel
- [ ] Record the plan's exact NPROC, entry-process, CPU and RAM figures
- [ ] Confirm the minimum cron interval the plan permits
- [ ] Confirm the target domain is not serving an existing site —
      **nothing gets overwritten without explicit authorisation and a backup**
- [ ] Confirm outbound HTTPS reaches the database host, Meta, Razorpay and Firebase
- [ ] Run `pnpm preflight` against the production database and get ten green checks

---

## Database setup

Create the three roles on the managed provider. They are not interchangeable;
see `docs/SECURITY.md`.

```sql
CREATE ROLE gym_owner LOGIN PASSWORD '...' NOSUPERUSER CREATEDB NOBYPASSRLS;
CREATE ROLE gym_app   LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOBYPASSRLS;
CREATE ROLE gym_jobs  LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB BYPASSRLS;

GRANT CONNECT ON DATABASE gym_cloud TO gym_app, gym_jobs;
ALTER SCHEMA public OWNER TO gym_owner;
```

Some managed providers do not allow `CREATEDB`. In that case set
`shadowDatabaseUrl` in the datasource block and point it at a second empty
database — Prisma needs one for drift detection in `migrate dev`.
`migrate deploy`, which is what production uses, needs no shadow database.

### Create the application's role with SQL, never in the provider's console

This is the one setup mistake that breaks tenant isolation without breaking
anything you can see.

`BYPASSRLS` does not leak through role membership — a role that merely
belongs to a `BYPASSRLS` role still reads nothing. But it can `SET ROLE` to
that role, and then it reads everything. Verified against PostgreSQL 16: a
member of a `BYPASSRLS` role returned 0 rows from a `FORCE ROW LEVEL
SECURITY` table with a deny-all policy, and returned every row one
`SET ROLE` later.

Managed providers hand out that membership by default. Neon grants
`neon_superuser` — which carries `BYPASSRLS` — to every role created through
its console, its API or its CLI. Create `gym_app` that way and:

- `rolbypassrls` on the role itself is still `false`
- every policy is present and correct
- the isolation suite passes
- and the application is one statement away from reading every gym

Create the three roles by running the SQL above over a `psql` connection.
Roles created with plain `CREATE ROLE` get no provider role grant.

Then prove it, against the real database, before anything is deployed:

```bash
pnpm preflight
```

Ten checks, read-only, nothing written. It asks what the application's role
can *become*, not only what it is; that every tenant table has RLS enabled
**and forced**; that no RLS table was left without a policy; that the
application's role, with no organization in context, really does read zero
rows; that migrations are all applied and none failed; and that the
connection is encrypted, since member health declarations and staff salaries
cross that link. It exits non-zero and says what to fix.

Run it again after any change to roles or migrations. A provider that resets
role grants during a plan change or a restore puts the trap back.

Use the **pooled** connection string for `DATABASE_URL` and the **direct**
one for `DIRECT_DATABASE_URL`. The row-level security context is set with
`set_config(..., true)`, which is transaction-local and therefore correct
behind a transaction-mode pooler.

---

## Deploying

1. In hPanel, create a **Node.js Web App** on the target domain.
2. Connect the GitHub repository and select the `main` branch. Pushes rebuild
   automatically.
3. Build command `pnpm build`, start file as generated by the Next.js build.
4. Set environment variables in the deploy configuration — every key in
   `.env.example`. Never in the repository.
5. Install the SSL certificate and enable the HTTPS redirect.
6. Add the cron entries below.

Migrations run in CI **before** the deploy, so new code never meets an old
schema. See `.github/workflows/ci.yml`.

---

## Cron

Two entries carry all sixteen jobs. Each endpoint verifies `CRON_SECRET`,
claims its window in `job_runs`, processes a bounded batch, and returns well
inside the timeout.

```cron
# every minute — drains the outbox across all tenants
* * * * * curl -fsS -m 110 -H "x-cron-secret: $CRON_SECRET" https://YOUR_DOMAIN/api/cron/dispatch >/dev/null 2>&1

# every 15 minutes — the scheduled sweep; each job decides whether it is due
*/15 * * * * curl -fsS -m 110 -H "x-cron-secret: $CRON_SECRET" https://YOUR_DOMAIN/api/cron/sweep >/dev/null 2>&1
```

Every job is idempotent and windowed, so it is correct whatever interval the
plan actually enforces. Add a free external scheduler — a GitHub Actions
scheduled workflow, or cron-job.org — calling the same endpoints as a
redundant trigger. A double trigger is harmless: the second caller finds the
claim in `job_runs` and returns. Shared-hosting cron does silently stop, and
a renewal reminder that never sent is lost revenue nobody notices for a month.

---

## Backups

The managed provider's point-in-time recovery is the first line. On top of
that, take a logical dump nightly to object storage **in a separate
account**, because a backup inside the thing you are backing up is not a
backup.

### `pg_dump` will fail if you run it the obvious way

Every tenant table here has `FORCE ROW LEVEL SECURITY`, which applies to the
table's owner as well — that is what FORCE means. During a dump no
organization is in context, so `current_org_id()` is NULL, the policy denies,
and pg_dump stops with:

```
pg_dump: error: query failed: ERROR:  query would be affected by
row-level security policy for table "attendance"
```

It does **not** quietly write a dump with the rows missing, which is the one
mercy in this. But a nightly job set up with the owner credentials — the
obvious thing to do — fails every night, and if nobody reads the cron mail
you find out on the day you need it.

So: **dump as a role with `BYPASSRLS`, restore as the owner.** `gym_jobs`
already has BYPASSRLS, for the cron work. The owner is needed for a restore
because it recreates tables, policies and grants, which BYPASSRLS does not
permit. Two roles, two jobs, and neither can do the other's.

### Take one, and prove it

```bash
# A backup, nothing else.
pnpm backup

# A backup, restored into a throwaway database and checked.
pnpm backup:verify
```

`--verify` is what earns the word backup. It restores the dump into a scratch
database, compares the row counts table by table, and — the part a plain "did
it restore" check misses — confirms that row-level security came back
**enabled and forced**, with its policies, on every table it was on. A
restore that loses RLS comes back up with every gym able to read every other
gym's data, and it would look entirely healthy.

It never writes to the database it dumped, and it drops the scratch database
afterwards.

Run it before go-live and once a quarter after. Keep the output: "53
populated tables restored with their rows, and row-level security came back
enabled and forced on 82 tables with 82 policies" is the sentence you want
in front of you when somebody asks whether the backups work.

One trap found while building this, worth knowing if you ever write your own
check: `n_live_tup` is an estimate maintained by autovacuum and reads 0 for a
table that has rows but has not been analysed. A comparison built on it
silently skips exactly the tables most recently written to — the first
version of this script reported 14 populated tables where there were 53. It
now refreshes statistics on both sides before comparing.

---

## When to leave shared hosting

Move to a Hostinger VPS or equivalent when any one of these is true:

- More than roughly 40 paying tenants
- Sustained 503s traced to the process limit
- A tenant needing real-time kiosk sockets
- Report generation that cannot be chunked under 120 seconds
- **Your own gym going live** — given the four Node.js apps already on this plan

On a VPS, PostgreSQL, Redis and real background workers all become available,
the database can come in-house, and the architecture gets simpler rather than
more complex. The application is written to make that a redeploy: no
Hostinger-specific APIs, no dependency on the panel, everything configured
through environment variables.

---

## Rollback

1. Revert the commit on `main`; Hostinger rebuilds from the previous code.
2. Forward-fix the database. Never run a down migration against production —
   write a new migration that corrects the state.
3. If the data is wrong rather than the schema, restore to a point in time on
   the managed provider and replay.
