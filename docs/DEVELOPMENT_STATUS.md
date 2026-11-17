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
| Zod contract layer | One schema validates the form and the API body; the handler is typed on the schema's output |
| Error taxonomy | 27 stable error codes with honest HTTP status; 404 for both "missing" and "not yours" |
| Permission engine runtime | Role → overrides → branch scope → plan features, resolved once per request |
| Argon2id password hashing | Prebuilt binaries, no compiler needed at install — which matters on shared hosting |
| TOTP (RFC 6238) | Implemented on `node:crypto`; ±1 step drift window, recovery codes |
| Login with lockout | Per-email and per-IP throttling; identical message and timing for unknown accounts |
| Database-backed sessions | Only the SHA-256 of the token is stored; logout revokes server-side |
| Tenant provisioning | Gym, branch, owner, trial, consent rows, tax rate and invoice sequence in one transaction |
| Organization switching | Membership verified server-side, session row rewritten, switch audited |
| Audit logging with redaction | Written in the same transaction as the change; credentials never reach the log |
| Next.js 15 application | Builds clean, runs, serves the marketing site, auth pages, API and gym portal |
| Route handler wrapper | Origin check → session → permission → validation → handler, in that order |
| Permission-aware navigation | The sidebar renders from the resolved permission set, with no role checks in markup |
| Security headers + CSP | Nonce-based CSP, HSTS, frame-ancestors none, no `x-powered-by` — verified over HTTP |
| Design system | Light and dark tokens, one accent, cards, skeletons, empty and error states |
| **Auth and permissions suite — 34 tests** | **Passing on the application role, not a privileged one** |
| **HTTP smoke suite — 40 checks** | **Passing against a running server with curl and a real browser** |

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
| Member management | Registration, search, filters, profile, bulk import — Phase 2 |
| Membership engine | Plans, sell, renew, freeze, transfer — Phase 2 |

---

## Pending — this phase

- Password reset and staff invitation flows (tokens and hashing are built; the screens are not)
- MFA enrolment screen (TOTP, recovery codes and verification are built and tested)
- Member OTP login (contracts defined; the flow is not built)
- Platform console shell for Super Admin
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

## Bugs found by the verification layers, and fixed

Recorded because each one says something about where the bugs actually are.

| Bug | Found by | Why it mattered |
| --- | --- | --- |
| Login resolved no organization: the membership lookup ran with no actor context, so row-level security correctly denied the row | HTTP smoke test | It failed **closed** — the user landed with no gym rather than the wrong one — which is the right failure direction, but still a bug. The integration test had missed it because it used the privileged job role; that test now runs on the application role, as production does. |
| The CSP nonce never reached Next's script tags, so every page loaded with its JavaScript blocked | A real browser, via Playwright | Forms silently degraded to native GET submissions — which put a password in a URL. No amount of curl testing would have caught it: curl does not execute a Content-Security-Policy. The fix sets the CSP on the request headers so Next can stamp the nonce, and pages that ship interactive JavaScript now render per request. Both auth forms also carry `method="post"` so a JavaScript failure can never again put credentials in a query string. |
| The health endpoint was behind the auth gate | HTTP smoke test | Uptime monitoring would have reported the site down from the first deploy. |

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

**17 November 2026 — later**
Permission engine, authentication, tenant provisioning and the Next.js
application shell. Argon2id, TOTP, database-backed sessions, login with
lockout, organization switching, audit logging with redaction. Marketing
page, login, gym registration, permission-aware portal and dashboard, all
building and running. 114 tests passing: 40 isolation, 34 auth and
permissions, 40 HTTP checks against a running server. Three bugs found and
fixed, recorded above.

**17 November 2026**
Phase 1 opened. Monorepo, data model, migrations, row-level security,
tenant-scoped client, permission registry, role matrix, seeds and the tenant
isolation suite. Verified against PostgreSQL 16.15: 40 of 40 isolation tests
passing. Hostinger account audited — plan confirmed `hostinger_business` with
15 websites, 4 of them Node.js apps.
