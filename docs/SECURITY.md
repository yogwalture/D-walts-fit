# Security

How tenant isolation is enforced, what is deliberately outside it and why,
and the rules that must hold for every feature added from here on.

---

## The threat this document is about

One gym reading, changing or deleting another gym's data. Members, medical
declarations, salaries, revenue and WhatsApp access tokens all live in one
database. A single missing `WHERE organizationId = ...` is the difference
between a product and a breach.

The answer is not care. Care fails on a Tuesday afternoon. The answer is four
layers that must all fail together.

---

## Layer 1 — Tenant resolution happens once, server-side

The acting organization comes from the **session row in the database**. Never
from a URL segment, a header, a cookie value or a request body.

A user who edits `/api/v1/orgs/<another-org-id>/members` changes nothing: the
id in the path is compared against the session's organization and the request
is rejected if they differ.

Switching organization is an explicit authenticated action. `POST
/api/v1/session/organization` checks that an active `org_users` row links this
user to the requested organization, rewrites the session's `organizationId`,
and writes an `audit_logs` row. There is no client-side path to a different
tenant.

---

## Layer 2 — The application cannot build an unscoped query

Every service function takes a `TenantContext` as its first argument. Nothing
in `packages/core` reads a global or a request object to discover which tenant
it is serving.

Beneath that, `packages/db/src/tenant-client.ts` wraps Prisma in an extension
that is the real enforcement point:

- **Reads** (`findFirst`, `findMany`, `count`, `aggregate`, `groupBy`) get the
  tenant predicate wrapped in `AND`, so a hostile `OR` in the caller's filter
  cannot widen the scope.
- **`findUnique` by primary key** carries the tenant filter too, using Prisma's
  extended `whereUnique`. Guessing another gym's UUID returns nothing.
- **Writes** are stamped with the acting organization. A payload carrying a
  different `organizationId` throws `CrossTenantWriteError` rather than being
  silently corrected — a bug and an attack both deserve a stack trace.
- **No tenant context** throws `MissingTenantContextError` instead of
  returning rows.

Which models are tenant-scoped is derived from the generated schema at
startup, not from a hand-maintained list, so a table added next year cannot be
missed.

The raw client is not exported from the package index, and ESLint fails the
build on any import of it from application code.

---

## Layer 3 — PostgreSQL enforces it again, independently

Row-level security is enabled **and forced** on 79 tables. Forced matters:
without it, the table owner would bypass its own policies.

```sql
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON members
  USING      ("organizationId" = current_org_id())
  WITH CHECK ("organizationId" = current_org_id());
```

### Three database roles, and why they are not interchangeable

| Role | Used by | Privileges |
| --- | --- | --- |
| `gym_owner` | Migrations in CI only | Owns the schema; no runtime use |
| `gym_app` | Every request | **NOSUPERUSER, NOBYPASSRLS** — policies apply to its raw SQL too |
| `gym_jobs` | `/api/cron/*` only | `BYPASSRLS`, because cron work is legitimately cross-tenant |

The application's runtime role holds no DDL rights, so a compromised
application cannot drop a policy.

### The context is set per transaction, not per connection

```sql
SELECT set_config('app.current_org_id', $1, true);
```

The trailing `true` makes the setting transaction-local. This is what makes
RLS correct behind a transaction-mode connection pooler, where one physical
connection serves different tenants in sequence. A connection-level `SET`
would leak one tenant's context into the next request on that connection.

When the setting is absent, `current_setting(..., true)` returns NULL, the
comparison is NULL, and the policy denies. **The failure mode is an empty
result set — never a leak.**

### Three deliberate exceptions

**Shared library rows.** `roles`, `role_permissions`, `notification_templates`,
`exercises`, `video_categories` and `videos` allow a NULL `organizationId`,
meaning platform-provided content every gym reads. The policy permits reading
those rows and writing none of them: `USING (organizationId IS NULL OR
organizationId = current_org_id())`, `WITH CHECK (organizationId =
current_org_id())`.

**Platform-visible tables.** `tenant_subscriptions`, `tenant_invoices`,
`tenant_payments`, `usage_counters`, `org_feature_overrides`,
`support_tickets` and `audit_logs` add `is_platform_context() OR ...`. This
covers the SaaS business — plans, billing, support — and nothing operational.
Platform staff reading a gym's members or payments must enter that tenant
explicitly, which writes an audit row the gym owner can see.

**`sessions` is outside RLS entirely.** It is the authentication primitive: it
is looked up by `tokenHash` *before* any tenant is known, so a tenant
predicate cannot apply without breaking login. The compensating controls are
that the lookup key is a SHA-256 hash of a 32-byte random token, the row is
revocable server-side, and no application code queries the table by anything
else. This is the one place in the system where isolation rests on three
layers instead of four, and it is recorded here so nobody discovers it by
surprise.

---

## Layer 4 — Tests that try to break it

`tests/isolation/` seeds two gyms with deliberately identical data — same
member name, same phone number, same member code, same invoice number — and
then, acting as Gym A, attempts to reach Gym B by every route we could think
of. 40 tests, run on every commit and against staging before every production
deploy.

Crucially the suite tests layer 3 **separately**, with the application
extension bypassed entirely. If the application layer were deleted tomorrow,
those assertions must still pass.

The suite also asserts its own validity: a sanity block proves Gym A can read
its own records, so the isolation tests cannot pass merely because everything
is broken.

**A new route is not merged until the models it touches appear in this suite.**

---

## The permission engine

Permissions are data, not code. The interface hides what a user cannot do; the
API decides whether they may.

A key is `domain.resource.action` — `finance.payment.refund`,
`members.medical.read`, `staff.salary.read`. Resolution for an actor:

1. The permission set of their role, from `role_permissions`
2. Per-person overrides from `user_permission_overrides` — **an explicit deny
   always wins**
3. Intersected with branch scope from `org_user_branches`
4. Intersected with the features their gym's SaaS plan enables
5. Super Admin bypasses 1–4 but never bypasses layer 3

Resolved once per request, cached for the request, checked by a single
`requirePermission()` guard at the top of every route handler.

Four rules sit above any custom role and cannot be overridden:

- A member may only ever reach their own records — enforced by `memberId`
  equality, not by role
- Salary, bank details and commission are visible to Owner and Accountant only
- Integration credentials are write-only through the API, for everyone
- A branch-scoped user is confined to their branches on every route, including
  reports and exports

---

## Authentication

| Control | Implementation |
| --- | --- |
| Password storage | Argon2id, per-user salt, tuned work factor |
| Password policy | Minimum length with a breached-password check; no forced rotation |
| Web sessions | HTTP-only, Secure, SameSite=Lax cookie to a database session row — revocable instantly |
| Mobile sessions | 15-minute access token plus rotating refresh token, both tied to the same session row |
| MFA | TOTP with recovery codes. Mandatory for Super Admin, encouraged for Gym Owner |
| Lockout | Progressive delay then temporary lock, tracked per email and per IP |
| Password reset | Single-use, 30-minute, hashed token; using it revokes every existing session |
| Staff invitations | Expiring signed links. An administrator never sets another person's password |
| Member login | Phone or email with OTP, so members need no password |

---

## Secrets

No secret is ever in the repository or in client-side code. Everything is read
from environment variables set in the Hostinger deploy configuration and in
GitHub Actions secrets.

Per-gym integration credentials — WhatsApp access tokens above all — are
encrypted at the application layer with AES-256-GCM using a key held only in
the environment, so a database dump alone yields nothing usable. Credential
fields are write-only through the API: they can be set and tested, never read
back.

`.gitignore` excludes `.env`, keys, certificates and service-account files.
Add a secret-scanning pre-commit hook before the first real credential exists.

---

## The rest of the baseline

| Control | Where it lives |
| --- | --- |
| Input validation | A Zod schema on every route; the request is rejected before any logic runs |
| SQL injection | Prisma parameterises everything; `$queryRawUnsafe` fails lint |
| XSS | React escaping; no `dangerouslySetInnerHTML` without sanitisation; strict CSP |
| CSRF | SameSite cookies plus an origin check on every mutating route |
| Rate limiting | Per IP, per user, per organization; strict on login, OTP, check-in and bulk messaging |
| File uploads | Extension and MIME allow-list, magic-byte check, size cap, random stored key, signed-URL access only |
| Webhooks | HMAC verified against the raw body before parsing; replay-protected via `idempotency_keys` |
| Payment integrity | A payment exists only after the gateway webhook signature verifies. No card data is stored, ever |
| Audit logging | Every mutation to members, subscriptions, payments, refunds, permissions, settings and credentials |
| Transport | HTTPS with HSTS; database connections require TLS |
| Backups | Provider point-in-time recovery plus a nightly logical dump to separate object storage. Restore is tested, not assumed |
| Data protection | Versioned consent rows, export and deletion workflows, documented retention — aligned to India's DPDP Act |

---

## Health and sensitive data

Medical declarations, body-fat readings and progress photographs are sensitive
personal data and are treated as such:

- `member_medical_declarations` is its own table with its own permission
- `progress_photos` rows reference the `consents` row that permitted them;
  without consent the upload is refused
- Both are permission-gated and audited on read
- BMI is stored as an informational metric and is never presented as a
  diagnosis

---

## When a subscription lapses

A gym's data is **not** deleted. The account moves to read-only for a
configurable grace period during which the owner can still export everything.
Deletion happens only on explicit request or after the documented retention
period, and is recorded.

---

## Reporting a vulnerability

Email the address in the repository's organization profile. Please do not open
a public issue.
