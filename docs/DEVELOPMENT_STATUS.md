# Development status

Updated: 18 November 2026
Phase: **3 — Gym Operations**

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
| **HTTP smoke suite — 62 checks** | **Passing against a running server with curl and a real browser** |
| Password reset | Single-use hashed token, 30-minute expiry, per-address throttle, kills every session |
| Change password in session | Keeps the current device, signs out the rest |
| Staff invitations | Administrators never set another person's password; the invitee does |
| Invitation safety | Single-use, atomic claim (two racing accepts cannot both win), 7-day expiry, platform roles and foreign branches refused |
| Cross-gym invitations | Joining a second gym never resets an existing account's password |
| Two-factor enrolment | Two-step: nothing switches on until a code from the secret verifies |
| Recovery codes | Ten, shown once, stored hashed, single-use |
| Disabling two-factor | Requires the password; forbidden entirely for platform administrators |
| Member login by one-time code | Members need no password; the same phone at two gyms is two different people |
| Staff administration | List, invite, suspend, change role — with the last-owner and self-suspension guards |
| Suspension cuts sessions | Both for a staff member and for a whole gym, immediately |
| Platform console | Gym counts, MRR and ARR from the platform ledger, gym list, suspend and reactivate |
| Platform support access | Demands a written reason and writes an audit row the gym owner can see |
| Transactional email adapter | Provider behind an interface; with none configured, messages go to the log rather than nowhere |
| **Account flows suite — 30 tests** | **Passing on the application role** |
| **— Phase 2 —** | |
| Money in integer paise | 54-test suite: round trips, 1,000 additions of ₹0.07 landing on ₹70.00 exactly |
| Tax-inclusive GST split | ₹1,500 at 18% → ₹1,271.19 + ₹228.81; CGST and SGST always sum to the tax, at every amount tested |
| Inclusive membership dates | 1 Nov + 1 month ends 30 Nov; 31 Jan + 1 month clamps to 28 Feb instead of rolling into March |
| Indian financial year | April–March, written 2026-27 |
| Member registration with duplicate detection | Reports matches, does not block — families share phone numbers |
| Member codes | Allocated from a per-gym gapless sequence |
| Member list, search and filters | Server-side, scope-narrowed: a trainer's list is their own members |
| Medical data | Not fetched at all without `members.medical.read` — not fetched then hidden |
| Member edit and archive | Archive is a soft delete; invoices, payments and attendance survive |
| Membership plans | Per-plan price, tax rate, grace period, freeze allowance, transferability |
| Quote endpoint | The same function the sale uses, so the counter and the invoice cannot disagree |
| Selling and renewing | Subscription, invoice, lines, payment and member expiry in **one** transaction |
| Renewal stacking | A renewal starts the day after the current end date — no paid days are lost |
| **Gapless invoice numbering** | **Eight concurrent sales produce eight sequential numbers, no gaps, no duplicates** |
| Freeze and unfreeze | Credits lost days to the end; the allowance is cumulative across the membership |
| Extension and cancellation | Both demand a written reason; a refund is a new row, never an edit to the payment |
| Expiry job | Idempotent and batched, safe to run hourly |
| QR check-in | Rotating tokens; re-issuing revokes the previous code |
| Check-in eligibility | No membership, expired, frozen, suspended, sessions exhausted — each refused by name |
| Grace period at the door | Admitted with a renewal prompt rather than turned away |
| **Duplicate check-in guard** | **Two simultaneous scans produce exactly one attendance row** |
| Override at the door | Requires a reason; written to the audit log with the staff member's name |
| Counter payments | Receipt numbers from a gapless sequence; overpayment refused |
| **Razorpay webhook** | **Signature verified over the raw body before parsing; a body altered after signing is refused; capture is idempotent on the order id** |
| Gateway guards | Amount mismatch and tenant mismatch both refused; the tenant comes from our stored row, never the request |
| Dashboard | Members, attendance, money, leads and retention over eight configurable ranges |
| Dashboard charts | Revenue, visits and joins by month with empty months filled; plan mix, payment mix, peak hours |
| Action lists | Expiring soon, money owed, gone quiet — who to ring, not just how the month went |
| **Phase 2 operations suite — 54 tests** | **Against real PostgreSQL, on the application role** |
| **Contract suite — 10 tests** | **Contract enums compared against Prisma's generated enums, so they cannot drift** |
| **Phase 2 browser suite — 64 checks** | **Playwright: registration, plan, sale, check-in, payment, dashboard, edit, invoices, PDF, freeze — zero console errors** |
| GST tax invoice as a PDF | Rendered with pdfkit, no headless browser — Hostinger has no Chrome. Carries GSTIN, place of supply, HSN/SAC, taxable value, the CGST/SGST split and the amount in words |
| The rupee sign actually prints | DejaVu Sans subsetted to 30 KB and inlined; pdfkit's built-in Helvetica has no ₹ and would render every amount as a hollow box |
| Amounts in words | Lakh and crore, not millions — `rupeesInWords`, 4 tests |
| Invoices screen | Billed and owed totals, status filter, search; each row opens its PDF |
| Subscriptions screen | Freeze, unfreeze, extend and cancel on the row, each demanding a reason the server records |
| The gym's business day is one concept | `businessDayRange` — a UTC day put an Indian gym's "today" from 05:30 to 05:30 |
| **Invoice and subscription suite — 24 tests** | **Against real PostgreSQL, including a real rendered PDF** |
| Bulk member import from CSV and Excel | Upload, check, import — nothing created until the gym has seen the counts |
| A hand-written spreadsheet reader | No `xlsx` (the newest on npm carries a prototype-pollution advisory) and no `exceljs` (21 MB). Reads only a flat table; never evaluates a formula, follows an external reference or runs a macro; bounded against zip bombs |
| Column guessing | Recognises what gym software exports — "Mobile No", "DOJ", "Email ID" — and lets the user correct any of it before importing |
| Messy data handled | Country codes, leading zeros, Excel's scientific notation and serial dates, four date orders, blank rows, a single "Name" column |
| Problems reported by row number | Against the row in the user's own file, so it can be fixed in Excel rather than guessed at |
| Batched, resumable commit | 200 rows a call, idempotent per row — a file that times out resumes instead of duplicating |
| **Member import suite — 42 tests** | **Including a real .xlsx fixture in Excel's own format** |
| Expenses | Cost and tax recorded apart, because that is how a supplier's bill reads and the only way input tax credit can be claimed |
| Default expense categories | Rent, salaries, electricity and the rest, seeded on first use — the first expense does not begin with inventing a chart of accounts |
| The dashboard's net figure means something | It had shown expenses as zero since Phase 2, because nothing could record one |
| Payment receipts as PDFs | Half a page: who paid, how much, by what means, towards what, and who took it |
| **Expenses and receipts suite — 20 tests** | **Including a real rendered receipt** |
| **Permission registry guard** | **Every permission key the code checks is compared against the seeded registry** |
| **— Phase 3 —** | |
| The team directory | Who is on the team, what they specialise in, how many members each trainer carries |
| Staff profiles | Designation, department, specialisations, certifications, joining date |
| Salary and bank details | Behind `staff.salary.read` — not fetched at all without it, and the figure is kept out of the audit log |
| Trainer assignment | From the member profile, with the assignment history kept and the member's timeline updated |
| A trainer's own members | The trainer role has carried OWN scope since Phase 1; something finally fills it |
| Branch-aware assignment | A trainer limited to certain branches cannot be handed a member from another |
| Pending invitations | Visible with who sent them and when they expire, and revocable — an invited person has no account until they accept |
| **Staff and trainer suite — 20 tests** | **Including that a manager can edit a profile but not set a wage** |
| Enquiries | Every walk-in and phone enquiry, ordered by how overdue its follow-up is — the list a gym works from on a Monday, not an alphabetical directory |
| A call and its next follow-up are one action | A follow-up that has to be scheduled as a separate step is one that does not get scheduled |
| Trials | Booked against a trainer, with the outcome recorded, because a trial nobody follows up on is a free session |
| Converting an enquiry | Creates the member in one transaction, keeps `convertedFromLeadId`, and writes both the enquiry's history and the member's timeline — so a gym can answer "which of our members came from Instagram" |
| Duplicate enquiries warn rather than block | Couples and families share one phone number; the counter can record it anyway |
| Conversion rate over decided enquiries | `converted / (converted + lost)` — an open enquiry has not failed, and counting it as one flatters nobody |
| **Enquiries suite — 20 tests** | **Including that one gym's pipeline figures cannot see another's enquiries** |
| Plan boundaries are a sale, not an error | A gym whose plan excludes a feature meets a page naming the plan that includes it and its price — not a 500 |
| Plan chosen at registration | The signup form reads the live plan table, so a pricing change is a data change |
| **Plan-lock tests — 4 tests** | **Including that a role denial and a plan lock are never confused for each other** |
| Classes and the timetable | A day at a time, led by the places left — the question asked at the desk, not a month grid |
| Capacity that holds under load | The class row is locked for the duration of a booking, so two people pressing Book on the last place cannot both get it |
| A waitlist that moves | Cancelling promotes the first person waiting in the same transaction, and says who, because somebody has to tell them |
| Weekly classes | Generated as real rows up to twelve weeks ahead; a week the trainer is busy is skipped with a reason rather than failing the series |
| No trainer in two rooms at once | Overlap refused against live sessions; a cancelled class frees its slot |
| The class register | Marking a member present also records their gym visit, so a member who only comes to the 7am class is not counted as never attending |
| Cancelling a class | Cancels its bookings and hands back the list of members to ring — one entry per person, however many sessions they had booked |
| **Classes suite — 30 tests** | **Including three genuinely concurrent bookings for one place** |

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

## In progress — the rest of Phase 2

| Item | Note |
| --- | --- |
| Transferring a membership between branches | Works over the API and is tested; no screen offers it yet |
| Inventory and point of sale | Models exist; no service or screen yet |
| Staff attendance, shifts and leave | Models and permissions exist; no service or screen yet |
| Devanagari and other Indic names on the PDF | pdfkit cannot shape complex scripts. `hasUnsupportedScript` detects the case so it can be reported rather than printed as boxes; a gym recording names in Marathi needs a different renderer |
| Razorpay checkout in the browser | The server half is built and tested; the checkout flow needs real test credentials |
| First deployment to Hostinger over HTTPS | Blocked: needs a database connection string and a GitHub repository |

### What is deliberately not in the navigation

The sidebar lists only pages that exist. Every unbuilt destination carries
`built: false` in `apps/web/app/(gym)/layout.tsx` and is hidden until its
screen lands — a menu item that 404s teaches people not to trust the menu.

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
| The duplicate check-in handler ran a query inside a transaction PostgreSQL had already aborted | Phase 2 operations suite | Two people scanning the same card a second apart produced a 500 instead of "already checked in". PostgreSQL aborts the whole transaction when a statement fails, so the recovery read could never have worked. The identity is now carried out of the failed transaction in the error and the winning row is read in a fresh one. |
| `make_interval(months => …)` with a Prisma number | Phase 2 operations suite | Prisma sends a JavaScript number as `int8` and PostgreSQL has no such overload, so **every dashboard chart threw**. A unit test on the service would have passed; only a real database has the function signature. |
| The dashboard route dropped custom date ranges | Reading the code while wiring the route | The service names the fields `from`/`to`, the contract said `fromDate`/`toDate`, and both are optional — so a custom range silently showed the default instead. Every route now maps fields one by one rather than spreading, which turns this class of mistake into a compile error. |
| Member addresses and emergency contacts were silently discarded | Phase 2 browser suite | The contract nested them as `address: { … }`; the service takes flat `addressLine1`, `city`, `postalCode`. Zod stripped the unknown keys and TypeScript saw nothing wrong, because every one of those fields is optional. A receptionist would have typed an address at the desk and found it gone. Contracts are now flat, matching the columns. |
| The CSRF origin check depended on `APP_URL` being exactly right | Phase 2 browser suite | On any host where `APP_URL` did not match the address the browser actually used, **every form on the site returned 403** — a miserable thing to debug at go-live, behind a proxy, on launch day. The check now compares the Origin against the `Host` the browser addressed, which configures itself; `APP_URL` is an extra allowance rather than the gate. |
| Seven contract schemas had drifted from the database and the services | Typechecking the new routes, then a contract test | An invented `BIOMETRIC` check-in method, a `NETBANKING` payment method the enum does not have, plan fields named `sessionsTotal` and `isPublic` that the service calls `sessionCount` and `visibleToMembers`. A test now compares every contract enum to Prisma's generated enums, so the schema and the API cannot drift apart in silence. |
| The sidebar linked to eleven pages that do not exist | Phase 2 browser suite, via 404s on Next's prefetches | Every one was a button that did nothing. The navigation now hides anything unbuilt. |
| The PDF read its fonts from disk through `__dirname` | Requesting a PDF from a production build | `__dirname` resolves into the build's chunk directory and the font files are not copied there, so **every invoice download failed with ENOENT**. It typechecked, it worked in development, and it would have shipped. The fonts are now inlined as base64, which also removes the filesystem dependency entirely. |
| A partial edit wiped every field it did not mention | Phase 2 browser suite — a surname went missing on an unrelated screen | Collapsing an absent value to null made "absent" and "emptied" the same thing, so **changing a member's phone number silently erased their surname, email, address, emergency contact, occupation, notes and assigned trainer**. Thirteen fields. Invisible to the typechecker because every one of them is optional. |
| A payment against an invoice left the membership unpaid | Invoice suite | `recordPayment` only updated the subscription when the caller named it — but reception settles an *invoice*, not a subscription. The membership went on reporting money as owed after it had been collected, so the gym would ring a member who had already paid. |
| "Collected today" counted a UTC day | A test run that crossed midnight IST | The till figure rolled over at 05:30 rather than midnight, so a late shift's takings landed on the wrong date and the cash count disagreed with the screen. The gym's business day is now one concept used everywhere, including in the pages, which were passing UTC dates into the reports. |
| A plan created through the API silently charged 0% GST | Rendering a PDF for a plan created over curl | `taxRateId` was optional and defaulted to nothing. GST applies to a gym membership in India, so the gym's default rate now applies when none is named; `null` means a deliberately tax-free plan. An under-collection nobody notices until the return is filed. |
| Freezing a membership made its row vanish | Phase 2 browser suite | The default filter was "Active", so pausing a membership removed it from the list the receptionist was looking at mid-conversation. "Live" — active plus frozen — is now the default, because that is the question a gym actually asks. |
| Imported members were created with no branch | Member import suite | A staff member whose read scope is branch-limited sees members by branch, so a member with none is invisible to them — **an import of four hundred members produced an empty members screen**. The import now falls back to the primary branch, exactly as registering by hand does. The worst possible first five minutes with the product. |
| "Emergency Contact Number" was read as the emergency contact's *name* | Member import suite | The column guesser took the first field whose synonym was a substring, and `emergencyContactName` is declared before `emergencyContactPhone`. A gym's emergency phone number would have been filed as a name — in the one field that exists for an emergency. The longest matching synonym now wins. |
| The expense service checked permissions that do not exist | Expenses suite | It asked for `finance.expense.create` and `finance.expense.delete`; the registry has `finance.expense.manage`. **A gym owner could not record an expense in their own gym.** Nothing in a typechecker can catch a string that does not match another string, so a test now compares every permission key the code checks against the seeded registry. |
| Inviting someone left no trace anywhere | Phase 3 browser suite | An invited person has no account until they accept, so the team page showed nothing: **the person who sent an invitation could not tell whether it had gone out, when it expired, or how to take it back.** Pending invitations are now listed with the sender and the expiry, and can be revoked. The invited person's name is stored so the list shows a person rather than a bare email address. |
| The member profile's Edit button went nowhere | Phase 2 browser suite | Same class of problem; the page was built rather than the button removed, since the service behind it was already written and tested. |

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

**18 November 2026 — Classes, capacity and a waitlist that moves**
Two things decide whether a gym timetable works, and the calendar is
neither. Capacity, because two members press Book on the last place within
the same second — so a booking locks the class row and decides from the
locked figure. The test fires three concurrent requests at a class with one
place; with the lock removed, all three get in, which is exactly the bug
this prevents. And the waitlist, because one that does not move when
somebody cancels is decoration: cancelling now promotes the first person
waiting in the same transaction and says who, since somebody has to tell
them. Repeating classes are materialised as real rows up to twelve weeks
out, because the deploy target has no worker to extend them — and a week
the trainer is already busy is skipped with a reason instead of failing the
whole term.

Writing the browser test found a live bug nothing else had: the phone
normaliser stripped a leading `91` unconditionally, so **a member whose real
ten-digit number starts 91 — 9112…, 9145…, live Indian series — could not be
registered, found, or signed in at all.** The country code is now removed
only when ten digits remain. 592 checks passing: 333 tests, 130 HTTP checks
and 129 browser checks.

**18 November 2026 — Enquiries, and the difference between a locked door and a dead end**
A gym's growth is almost entirely one thing: someone walks in, asks the
price, says they will think about it, and is never called again. Enquiries
exist to stop that, so logging a call and moving the follow-up are a single
action rather than two, and the default view is the overdue ones.

Building it surfaced something worse than a missing feature. The CRM is a
Growth-plan feature, and the permission engine removed plan-gated
permissions from the resolved set — making "your plan does not include this"
indistinguishable from "your role does not allow this". A gym owner on
Starter clicking Enquiries got **a server error on a page we are trying to
sell them**. Plan locks are now tracked separately: the API answers
`FEATURE_NOT_IN_PLAN` with the feature named in plain words, the page
explains which plan includes it and what it costs, and the sidebar keeps the
item visible with a "Locked" tag — because nobody buys what they never see.
The registration form also only ever sold the cheapest plan; it now reads
the plan table and lets a gym choose, which is what decides the features
they can try during the trial. 536 checks passing: 302 tests, 121 HTTP
checks and 111 browser checks, with row-level security still forced on all
81 tenant tables.

**18 November 2026 — Phase 3 begins: the team, and trainers who have members**
The trainer role has carried OWN scope on members since Phase 1 and nothing
ever filled it, so a trainer signed in to an empty list; the member profile
said "Trainer: Not assigned" with no way to assign one. Both are now real.
Salary and bank details sit behind their own permission, are not fetched at
all without it, and the figure is kept out of the audit log — anyone who can
read the log would otherwise be able to read every wage in the gym. 477
checks passing: 278 tests, 106 HTTP checks and 93 browser checks.

**18 November 2026 — Expenses and payment receipts**
What the gym spends, and the slip a member who paid cash walks away with.
The dashboard's "net" had been revenue wearing a different label since
Phase 2, because nothing could record an expense. 446 checks passing: 258
tests, 99 HTTP checks and 89 browser checks. One bug found and fixed — a
service checking permission keys the registry does not have, which left a
gym owner unable to record an expense in their own gym — and a test added
so an invented key cannot pass again.

**18 November 2026 — Bulk member import**
Upload a CSV or Excel file, see exactly what would happen, then import. The
spreadsheet reader is hand-written rather than a dependency, because the
newest `xlsx` on npm carries a prototype-pollution advisory and this parses
files uploaded by staff. 403 checks passing: 238 tests, 89 HTTP checks and
76 browser checks. Two more bugs found and fixed — an import that produced
members no branch-scoped user could see, and a column guesser that filed an
emergency phone number as a name.

**18 November 2026 — Phase 2: tax invoices, the subscription lifecycle on screen**
The GST tax invoice as a PDF, the invoices screen, and freeze/extend/cancel
on the subscriptions row. 341 checks passing: 196 tests, 81 HTTP checks and
64 browser checks. Seven more bugs found and fixed, listed above — including
a PDF that worked in development and would have failed every download in
production, and a partial edit that silently erased thirteen fields.

**17 November 2026 — Phase 2 engine, API and screens**
Members, plans, the subscription lifecycle, attendance, payments, the
Razorpay webhook and the dashboard. 24 API routes, 9 screens, and the money
and date arithmetic tested hardest because that is where a bug costs a real
gym real rupees and nobody notices for a month. 290 checks passing: 168
tests, 74 HTTP checks and 48 browser checks. Nine bugs found and fixed along
the way, listed above — five of them invisible to the typechecker.

**17 November 2026 — Phase 1 complete**
Password reset, staff invitations, two-factor enrolment, member one-time-code
login, staff administration, the platform console and a transactional email
adapter. A `verification_tokens` table for every single-use token, outside
row-level security for the same reason sessions are, and documented as such.
166 checks passing: 104 tests and 62 HTTP checks. Driven through a real
browser with no JavaScript errors on any screen.

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
