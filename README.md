# Gym Management & Fitness Cloud

A multi-tenant gym management and fitness SaaS platform. One deployment serves
many independent gyms; each gym has its own members, staff, finances,
branding and data, and no gym can reach another's records.

Working product name. The name, logo, colours and domain are configuration,
not code.

---

## Status

**Phase 9 — Hardening. In progress.**
See [`docs/DEVELOPMENT_STATUS.md`](docs/DEVELOPMENT_STATUS.md) for what is
complete, pending and blocked. The full architecture and roadmap live in the
project's architecture document.

---

## What is here today

| Area | State |
| --- | --- |
| Data model | 92 models, 49 enums, verified against PostgreSQL 16 |
| Migrations | Applied in order and reversible by replay; the RLS policies are regenerated from the live schema after every table |
| Tenant isolation | 82 tables under forced row-level security, 82 policies |
| Permission registry | 140 permissions, 7 system roles seeded |
| Authentication | Argon2id, database sessions, TOTP, lockout, organization switching |
| Account flows | Password reset, staff invitations, two-factor enrolment, member one-time-code login |
| Administration | Staff management, audited support access, and a gym's own activity log — including what the vendor did on their account |
| Members | Registration with duplicate detection, bulk import from CSV/Excel, search, filters, profile, edit, archive |
| Memberships | Plans, quoting, selling, renewal, freeze, extension, cancellation with refund |
| Attendance | QR and search check-in, eligibility rules at the door, audited overrides, peak hours |
| Money | Counter payments, GST tax invoices and receipts as PDFs, expenses, the Razorpay webhook |
| Dashboard | Eight date ranges, six charts, and the three lists a gym actually works from |
| Team | Staff profiles, trainer assignment, permission-gated salary, pending invitations |
| Enquiries | Walk-ins and calls, follow-ups that move when a call is logged, trials, conversion to a member with the source kept |
| Classes | A day timetable, capacity that holds under concurrent bookings, a waitlist that promotes on cancellation, weekly repeats, and a register that counts as a gym visit |
| The shop | Products, a stock ledger that explains every figure, and a counter that raises a real GST invoice |
| Rota and leave | Who is in today, weekly shifts, and leave whose approval writes the register |
| Reports | GST summary by rate, collections by method and by who took them, what is owed by member, and CSV exports |
| Branches | Added within the plan's limit, with memberships movable between them |
| Subscriptions | Plan changes that say what they would cost first, a trial that ends read-only rather than locked, and nothing ever deleted for non-payment |
| Member app | Sign in with a code, see your membership and dues, book classes, check yourself in — installable, and it never caches the API |
| Messaging | WhatsApp Cloud API with per-gym encrypted credentials, approved templates, delivery receipts, STOP honoured on arrival, daily expiry reminders, and a queue that never claims to have sent what it has not |
| Plans and billing tiers | Chosen at registration, and a feature outside the plan explains itself instead of failing |
| Hardening | Public endpoints are rate-limited per connection, with the address read so a caller cannot choose it; a secret scanner gates every verification run; backups are proved by being restored, row-level security and all |
| Your data is yours | A gym downloads everything it holds as 43 spreadsheets in one click — no request, no waiting — and it keeps working when a trial has lapsed. A member downloads their own records from their own screen |
| Online payments | Each gym connects their own Razorpay account, so a member's fee settles into the gym's bank and never passes through us. A payment exists only after Razorpay confirms it to our server — not when a browser says so |
| The platform console | MRR and churn, a call list of trials ending and gyms lapsing with the owner's number, and a commercial page per gym with two levers: extend a trial, agree a limit outside the plan |
| The platform boundary | Platform context opens only for active platform staff, refuses a gym's own tables by name, and every action it takes lands in that gym's audit log with its reason |
| Web application | Next.js 15 — marketing page, auth, and twenty-eight screens of the gym portal, plus the member app and the platform console |
| Tests | **1,095 passing**: 40 isolation, 38 auth and plan locks, 30 account flows, 56 operations, 25 invoices, 42 import, 20 expenses, 20 staff, 21 rota and leave, 20 enquiries, 30 classes, 20 shop, 19 reports, 9 branches, 30 messaging, 18 member portal, 19 platform billing, 26 platform console, 23 online payments, 16 data export, 4 archive, 15 throttling, 16 secret scan, 4 backup, 14 contracts, 271 HTTP checks, 248 browser checks |

---

## Requirements

- Node.js 22 (18, 20 and 24 also supported by the deploy target)
- pnpm 10
- PostgreSQL 16, reachable over TLS

PostgreSQL is **not** available on Hostinger Web or Cloud plans, so the
database is hosted externally. See
[`docs/DEPLOYMENT_HOSTINGER.md`](docs/DEPLOYMENT_HOSTINGER.md).

---

## Getting started

```bash
pnpm install
cp .env.example .env          # then fill it in — see the comments in the file
```

Create the three database roles. They are not interchangeable, and the
separation is what makes row-level security meaningful:

```sql
-- owns the schema, runs migrations, never used at runtime
CREATE ROLE gym_owner LOGIN PASSWORD '...' NOSUPERUSER CREATEDB NOBYPASSRLS;

-- handles requests. RLS applies to every statement it issues, raw SQL included
CREATE ROLE gym_app   LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOBYPASSRLS;

-- background jobs only. Legitimately cross-tenant, so it holds BYPASSRLS
CREATE ROLE gym_jobs  LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB BYPASSRLS;

GRANT CONNECT ON DATABASE gym_cloud TO gym_app, gym_jobs;
ALTER SCHEMA public OWNER TO gym_owner;
```

Then:

```bash
pnpm db:generate         # generate the Prisma client
pnpm db:migrate:deploy   # apply migrations
pnpm db:seed             # permissions, roles, SaaS plans, two demo gyms
pnpm test:isolation      # prove the tenants are isolated
pnpm dev                 # http://localhost:3000
```

To run everything:

```bash
pnpm vitest run                                   # 576 tests against a real database
bash tests/e2e/http-smoke.sh                      # 271 checks against a running server
node tests/e2e/phase2-browser.mjs                 # 248 checks in a real browser
```

The browser suite needs Playwright and a server on `http://127.0.0.1:3100`
(`BASE_URL` overrides it). Set `RAZORPAY_WEBHOOK_SECRET` before the HTTP
suite to exercise the webhook's signature path as well as its refusals.

Then register a gym at `/register-gym`. You get a tenant, an owner account, a
branch, a 14-day trial, a tax rate and an invoice sequence — and you land on a
dashboard counting your own (empty) records.

To run the HTTP checks against it:

```bash
BASE_URL=http://localhost:3000 ./tests/e2e/http-smoke.sh
```

The seed creates two demo gyms — **Iron Temple Fitness** and **Pulse Fitness
Studio** — with deliberately identical data: the same member name, phone
number, member code and invoice number in both. That is what makes the
isolation suite meaningful. It seeds no passwords; accounts are activated
through the invitation flow, so no demo credential can reach production.

---

## Commands

| Command | Does |
| --- | --- |
| `pnpm dev` | Run everything in watch mode |
| `pnpm build` | Production build |
| `pnpm typecheck` | TypeScript, strict, no emit |
| `pnpm lint` | ESLint, including the isolation-critical rules |
| `pnpm test` | Unit and integration tests |
| `pnpm test:isolation` | The tenant isolation suite |
| `./tests/e2e/http-smoke.sh` | End-to-end HTTP checks against a running server |
| `pnpm db:migrate` | Create and apply a migration in development |
| `pnpm db:reset` | Drop, re-migrate and re-seed |
| `pnpm verify` | Secret scan, typecheck, lint and tests — run this before any push |
| `pnpm backup:verify` | Take a backup and prove it restores, policies and all |
| `pnpm scan:secrets` | Refuse to ship a credential (`--history` checks every commit) |
| `pnpm platform:admin --email you@example.com` | Promote an existing account to platform administrator |
| `pnpm platform:admin --list` | Who can open the platform console |

After adding a table, regenerate the policies so it cannot be left unprotected:

```bash
node packages/db/scripts/generate-rls.mjs > \
  packages/db/prisma/migrations/$(date +%Y%m%d%H%M%S)_rls/migration.sql
```

The generator reads `information_schema` rather than a hand-maintained list,
so a new tenant table is picked up automatically.

### The first platform administrator

There is no seeded super admin. A deployment ships with nobody able to open
the platform console, because an account with a known password in the
repository is the first thing anybody tries on a new install.

Register through the ordinary sign-up, then promote that account once, on
the server, with database access you already have:

```bash
pnpm platform:admin --email you@example.com
pnpm platform:admin --list            # who can open the console
pnpm platform:admin --email old@example.com --revoke
```

It never creates an account and never sets a password: the person has
already chosen their own, and nobody — including whoever runs this — has
seen it. Revoking leaves their own gym access untouched, since platform
staff and gym staff are separate things and somebody may be both.

---

## Repository layout

```
apps/
  web/                  Next.js — UI and API in one deployable
  mobile/               React Native + Expo (Phase 8)
packages/
  db/                   Prisma schema, migrations, RLS, tenant-scoped client
  core/                 All business logic, framework-free
  contracts/            Zod schemas and the types inferred from them
  integrations/         One adapter per external service, each mockable
  ui/                   Design system
  config/               Shared eslint and tsconfig
docs/                   Architecture, security, deployment, status
tests/
  isolation/            Tenant isolation suite — runs on every commit
  e2e/                  Playwright flows
```

Three rules keep this honest:

1. A route handler validates input, resolves tenant context, calls a service,
   and shapes the response. It contains no business logic.
2. A service never touches a request object.
3. An integration adapter never leaks its vendor's types past its own folder.

---

## How tenant isolation works

Four independent layers, described in full in
[`docs/SECURITY.md`](docs/SECURITY.md):

1. **Tenant resolution** — the acting organization comes from the session row
   in the database. Never from a URL, header or request body.
2. **The application cannot build an unscoped query** — a Prisma extension
   filters reads, stamps writes, and throws when there is no tenant context.
3. **PostgreSQL enforces it again** — forced row-level security on 82 tables,
   under a role that cannot bypass it.
4. **Tests that try to break it** — 40 of them, on every commit.

```ts
import { withTenant } from '@gym/db';

const members = await withTenant(ctx, async (tx) =>
  tx.member.findMany({ take: 25 }),
);
```

`withTenant` opens one transaction, applies the tenant context to the database
session with `set_config(..., true)` so it is transaction-local and therefore
correct behind a connection pooler, and runs your code inside it.

Never import the raw client. ESLint fails the build if you do.

---

## Licence

Proprietary. All rights reserved.
