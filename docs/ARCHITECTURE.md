# Architecture

The full architecture, entity model, role matrix, API design, sitemap, phase
plan, cost model and risk register live in the project's architecture
document, which is the reviewed and approved source of truth.

This file records the decisions as implemented, and is updated when the code
diverges from the plan.

## As built, Phase 1

- **One Next.js application** serves the UI and the API. Not a separate NestJS
  service: the hosting plan shares a 120-process budget across every site on
  it, and a second always-on runtime costs that budget for no architectural
  gain. Business logic lives in `packages/core`, framework-free, so lifting it
  to a separate API host later is mechanical.
- **PostgreSQL hosted externally.** Not available on Hostinger Web or Cloud
  plans. Prisma, the schema and the migrations are unchanged by this.
- **No background workers.** Every deferred operation is a cron-triggered
  HTTP endpoint that claims a window in `job_runs`, processes a bounded batch,
  saves a cursor and returns. Idempotent, so a double trigger is harmless and
  a missed tick is caught by the next one.
- **Object storage for everything uploaded.** The application directory is
  replaced on deploy, so nothing durable may live on the hosting disk.
- **Shared-schema multi-tenancy** with forced row-level security, rather than
  schema-per-tenant. One migration, one connection pool, and an isolation
  guarantee enforced by PostgreSQL itself. See `docs/SECURITY.md`.

## Layering

```
route handler      validate → resolve tenant → check permission → call service
      ↓
packages/core      business logic. Never sees a request object.
      ↓
packages/db        withTenant() → one transaction, tenant context applied to
                   the database session, tenant-scoped Prisma client
      ↓
PostgreSQL         row-level security, independently
```

Three rules keep it honest:

1. A route handler contains no business logic.
2. A service never touches a request object.
3. An integration adapter never leaks its vendor's types past its own folder.
