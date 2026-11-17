# Development status

Updated: 17 November 2026
Phase: **1 — Foundation**

This file is the single honest record of what works, what does not, and what
is waiting on someone. A feature is listed as complete only when its critical
workflow has been exercised end to end. An integration is listed as complete
only when real credentials have been used and a real call has succeeded.

---

## Complete and verified

| Item | Evidence |
| --- | --- |
| Monorepo scaffold — Turborepo, pnpm workspaces, strict TypeScript | `pnpm install` resolves; workspace packages link |
| Data model: 88 models, 45 enums | `prisma validate` passes |
| Initial migration | Applied to PostgreSQL 16.15; 85 tables created |
| Row-level security migration | Applied; 79 tables with RLS enabled **and forced**, 79 policies |
| RLS policy generator | Reads `information_schema`, so a new table cannot be missed |
| Three-role database separation | `gym_owner` (DDL), `gym_app` (runtime, NOBYPASSRLS), `gym_jobs` (cron, BYPASSRLS) |
| Tenant-scoped Prisma client | Filters reads, stamps writes, throws on missing context, refuses cross-tenant payloads |
| `withTenant` transaction wrapper | Sets `app.current_org_id`, `app.current_user_id`, `app.is_platform` transaction-locally |
| Permission registry — 140 permissions | Seeded |
| Seven system roles with the full matrix | Seeded: Super Admin 13, Owner 111, Manager 76, Reception 30, Trainer 25, Accountant 32, Member 17 |
| Four SaaS plans with limits and features | Seeded |
| Shared exercise library | 12 entries, readable by every tenant, writable by none |
| Two demo tenants with identical data | Seeded |
| **Tenant isolation suite — 40 tests** | **All passing against a real PostgreSQL** |
| CI pipeline | Lint, typecheck, migrate, seed, isolation suite, deploy gate |
| ESLint isolation rules | Raw client import, unpaginated `findMany`, and `$queryRawUnsafe` all fail the build |

### What the isolation suite actually proves

Acting as Gym A, against Gym B's real record ids:

- Reads return null across member, subscription, invoice, payment, attendance, lead, plan and branch
- `findUnique` by primary key returns null — guessing a UUID gains nothing
- A hostile `OR` clause cannot widen scope; an explicit `organizationId` filter cannot override the context
- `count`, `aggregate` and `groupBy` stay inside the tenant
- `update`, `delete`, `updateMany`, `deleteMany` affect zero rows
- A create carrying another tenant's `organizationId` throws rather than being silently corrected
- A create with no `organizationId` is stamped with the acting tenant
- A query with no tenant context throws instead of returning rows
- **With the application layer bypassed entirely**, raw SQL still cannot read, update or insert across tenants — and an unscoped raw `SELECT` returns zero rows
- The application role holds neither superuser nor `BYPASSRLS`
- Salary, medical declarations and WhatsApp credentials are unreachable across tenants

---

## In progress

| Item | Note |
| --- | --- |
| Next.js application shell | Scaffold, routing groups, middleware |
| Authentication | Argon2id, sessions, MFA, lockout, invitations |
| Permission engine runtime | Resolution order, `requirePermission()` guard, request-scoped cache |
| Design system | Tokens, primitives, data table, layout shell |

---

## Pending — this phase

- Organization switching with audit trail
- Tenant provisioning service (the one legitimate cross-tenant write)
- Password reset and staff invitation flows
- Seven-role login verification against a permissioned empty portal
- First deployment to Hostinger over HTTPS

---

## Pending — later phases

Phases 2 through 9 as set out in the architecture document: core gym
management, operations, communication, member experience, commercial SaaS,
advanced integrations, native mobile, hardening.

---

## Blocked — waiting on Yogeshwar

| Blocker | Blocks | Needed by |
| --- | --- | --- |
| Managed PostgreSQL provider decision and connection string | Any deployment | Before the first deploy |
| GitHub repository | Version control, CI, Hostinger auto-deploy | Before the first deploy |
| Hostinger Node.js app slot | Deployment — the account already runs 4 Node.js apps against a documented limit of 5 | Before the first deploy |
| Production domain | SSL, final URLs | End of Phase 1 |
| Phase 1 "definition of done" confirmation | Phase gate | Before Phase 1 closes |

Nothing above blocks continued development. The application is being built
host-agnostic and runs locally against PostgreSQL today.

---

## Known limitations, stated plainly

| Limitation | Why | Mitigation |
| --- | --- | --- |
| `sessions` is deliberately outside row-level security | It is the authentication primitive: looked up by token hash before any tenant is known | Keyed by SHA-256 of a 32-byte random token; documented in `docs/SECURITY.md` |
| Background jobs run under a `BYPASSRLS` role | Cron work is legitimately cross-tenant | Reachable only from `/api/cron` behind a shared secret; never from a request path |
| Column names are camelCase while table names are snake_case | Prisma's default column mapping | Consistent and documented; the RLS generator quotes identifiers correctly |
| `prisma migrate dev` needs a shadow database | Prisma's drift detection | `shadowDatabaseUrl` on managed providers; `CREATEDB` on the owner role locally |
| No integration is verified | No real credentials yet, by design | Each will move to "verified" only after a real successful call |

---

## Changelog

**17 November 2026**
Phase 1 opened. Monorepo, data model, migrations, row-level security,
tenant-scoped client, permission registry, role matrix, seeds and the tenant
isolation suite. Verified against PostgreSQL 16.15: 40 of 40 isolation tests
passing. Hostinger account audited — plan confirmed `hostinger_business` with
15 websites, 4 of them Node.js apps.
