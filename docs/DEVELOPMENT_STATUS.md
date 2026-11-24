# Development status

Updated: 24 November 2026
Phase: **9 — Hardening**

This file is the single honest record of what works, what does not, and what
is waiting on someone. A feature is listed as complete only when its critical
workflow has been exercised end to end. An integration is listed as complete
only when real credentials have been used and a real call has succeeded.

---

## Complete and verified

| Item | Evidence |
| --- | --- |
| Monorepo scaffold — Turborepo, pnpm workspaces, strict TypeScript | `pnpm install` resolves; workspace packages link |
| Data model: 92 models, 49 enums | `prisma validate` passes |
| Initial migration | Applied to PostgreSQL 16.15; 85 tables created |
| Row-level security migration | Applied; 82 tables with RLS enabled **and forced**, 82 policies. Regenerated from the live schema after every new table, so one cannot be left unprotected |
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
| The shop and the counter | A sale raises a real GST invoice in the same series as a membership, so the accountant reconciles one set of documents |
| Stock as a ledger | Every change writes a movement carrying the balance after it; a correction is a signed difference, never a new total typed over the old one |
| Stock cannot be oversold | The product row is locked for the duration of a sale, so the last unit cannot go to two tills |
| Wastage needs a reason | Stock leaving without a sale is otherwise indistinguishable from theft in the audit trail |
| A walk-in pays in full | There is no account to chase a balance on; a member may owe |
| Reorder level | A product at or below it is flagged, because a gym that waits for zero has already turned somebody away |
| **Shop suite — 20 tests** | **Including two concurrent sales of a single unit** |
| The staff register | Everybody on the team appears, including those nobody has marked — at ten in the morning the question is who has *not* arrived |
| The rota | Weekly shifts or a one-off for a date, with the one-off beating the pattern |
| Leave | Requested, approved or refused, with overlapping requests blocked |
| Approved leave writes the attendance | Otherwise the register shows a sanctioned absence as an unexplained one and payroll docks a day the gym agreed to |
| A worked day is never overwritten | Approving leave over a day already marked present leaves it alone |
| Nobody approves their own leave | The owner holds every permission in the gym and still cannot sanction their own absence |
| An invitation prefills the invitee's name | The inviter already typed it; the invitee corrects it rather than typing it again |
| **Rota and leave suite — 21 tests** | **Including that a person with no branch is still on the rota** |
| Reports | What a gym hands the accountant, rather than what it watches day to day |
| GST summary by rate | A return is filed by rate; one figure for tax collected cannot be filed at all. CGST/SGST come from the rate's own components, never from halving |
| What is owed | Grouped by member and oldest first, because a gym rings a person rather than a document |
| Membership report | Renewals told apart from first sales, so churn is visible; no expiries means nothing to measure, not perfect retention |
| CSV export | Built from the same services as the screen, every cell quoted, formula-leading cells defused, and never held by a shared cache |
| **Reports suite — 19 tests** | **Including that the rates add up to the reported total** |
| Branches | Added from Settings, within the plan's limit, with the refusal naming the plan |
| Moving a membership between branches | On the row where a receptionist already is; the dates and the money are untouched and only a plan that permits it offers the button |
| The gym owner is organization-wide | A branch row narrows every grant to that branch, which is right for a manager and wrong for the owner |
| **Branches suite — 9 tests** | **Including that a gym cannot move a membership to another gym's branch** |
| **— Phase 4 —** | |
| WhatsApp, official Cloud API only | Each gym brings its own number and token; one shared number would put every gym's ban risk on one account |
| Credentials encrypted at rest | AES-256-GCM, key from the environment, write-only through the API — a token comes back only as its last four characters |
| Connecting verifies by reading, never sending | The connection is switched on only if Meta answers; verifying should not message anybody |
| Templates | WhatsApp accepts only what it has approved, under the name *it* assigned, so an unapproved template is refused here rather than failing at the API |
| Editing an approved template loses the approval | Meta approved particular words, not a slot to put words in |
| Campaigns queue, they do not send | A gym pressing Send and waiting on four hundred provider calls is a gym staring at a timeout |
| Nothing is "sent" until a provider accepts it | With no connection, messages are **held** — not failed, not ticked — and go the moment it is made |
| Opt-outs checked twice | At queue time and again at send time, because a STOP arriving in between is exactly when it arrives |
| Marketing is opt-in, utility is opt-out | Silence is consent for an invoice, not for an offer |
| Sending is a bounded cron drain | No workers on the deploy target; the batch fits inside the 120-second request limit and one bad row cannot abandon it |
| Delivery receipts | A sent message becomes delivered or read from WhatsApp's own callback — "we sent it" and "it arrived" are different claims |
| STOP is honoured on arrival | An inbound opt-out applies across categories: somebody who asked to be left alone asked once |
| The webhook verifies the raw body | Signed with the Meta app secret and checked before anything parses it, like the Razorpay one |
| The tenant comes from our records | Resolved from the phone number id we stored, never from anything in the payload a sender could choose |
| Expiry reminders | A daily cron run, keyed on the member, the subscription and the day, so firing twice cannot message anybody twice |
| One environment file | The web app reads the repository's `.env` rather than keeping its own copy — two files that drift is a key rotated in one place and still failing in the other |
| **Messaging suite — 30 tests** | **Including that a timeout is retried, a duplicate send is not, and a forged receipt is refused** |
| **— Phase 5 —** | |
| Member sign-in | A number and a code, because a member signs in three times a year and would reset a password every time |
| Login codes go over WhatsApp | Where the gym has it connected and an approved authentication template; otherwise email, and never a claim that it sent |
| The member id comes from the session | Never from a URL or a body — there is no input through which to ask for somebody else's invoices |
| A member's own page | How long is left, what is owed, visits, and what they have booked — the four things they open it for |
| Classes, as one list | What is on and what they have booked are the same screen in a member's head; a separate bookings page is where double bookings come from |
| Booking reuses the staff service | Two implementations of "is there a place left" is how a class is oversold by the app while the desk shows it full |
| Self check-in | The entrance QR rotates, so it only works at the gym, and the eligibility rules are the door's own |
| Installable | Manifest served from configuration so a white-label gym installs its own name; the service worker caches the shell and **never** the API |
| **Member portal suite — 18 tests** | **Including that a member cannot reach another member's money or another gym's anything** |
| **— Phase 6 —** | |
| A gym's own subscription page | Plan, trial, invoices, and what they are using against what they pay for |
| Changing plan says what it would do first | The price difference, the features lost, and — if the gym is too big — the number that makes it impossible |
| A downgrade that would break a gym is refused | "You have 412 members and Starter covers 200" is actionable; "cannot downgrade" is not |
| An upgrade takes effect at once | Deferring it means the interface says one plan while the engine enforces another |
| A trial that ends goes read-only, not locked | Every record readable and exportable; no new money taken until a plan is paid for |
| Read-only is enforced in the permission engine | One place, so no screen can forget it; reads, exports and the billing page survive it |
| The refusal names the bill, not their permissions | "You do not have permission" sends an owner hunting through roles for a setting that was never the problem |
| Nothing is deleted for non-payment, ever | Not after grace, not after cancellation — a thing to be incapable of rather than to have a policy about |
| Our own invoices carry GST | Software sold by an Indian business; the gym needs the tax invoice to claim input credit |
| The billing run is idempotent | Running it twice cannot invoice a gym twice, and a gateway retry cannot credit one twice |
| **Platform billing suite — 19 tests** | **Including that every record survives a trial ending and the grace running out** |
| Super Admin console | MRR, ARR, collections, churn, and every gym — the figures needed to run this as a business rather than as a gym |
| A call list, not a count | "Three gyms past due" cannot be phoned. Trials ending, invoices unpaid and gyms gone read-only, each with the owner's name and number, soonest-to-lose first |
| Narrowed in SQL, not after the fact | The list filters and orders in the query before it takes a page, so a gym about to lapse cannot be dropped by whichever rows the planner returned last |
| A gym's page, commercially | Plan, price, usage against limits, our invoices to them, lifetime value — and no member, payment or message of theirs anywhere in it |
| Extending a trial | Counted from today when the trial already lapsed, capped at 60 days, and it lifts read-only — a gym evaluating the software has to be able to use it |
| A limit agreed with one gym | A deal struck with one customer no longer needs a plan tier everybody else can see and buy |
| Both write into the gym's own audit log | With the reason, which is the part that explains the decision six months later |
| Platform context is checked in the data layer | `withPlatform` refuses to open for anybody who is not active platform staff, so the route guard is not the only thing standing there |
| Platform context refuses a gym's tables outright | RLS already answers nothing there; the extension turns that silent empty result — indistinguishable from a gym with no members — into an error naming the call that was meant |
| Counts come from the job role, deliberately and narrowly | Usage against a plan names nobody; the rule is counts and the account holder's own contact details, nothing else |
| No seeded super admin | An operator registers normally and promotes themselves once with `pnpm platform:admin`. A known password in the repository is the first thing anybody tries on a new deployment |
| A gym's own activity log | Who changed what, including us — with a view that shows only what the software company did. Every claim elsewhere that "the owner can see it" is settled on that screen |
| The log is not a second copy of their data | Stored before/after payloads stay out of the view; the summary names their own member, because "a member was added" tells an owner nothing |
| Support is named as support | That the vendor acted is the gym's business; which person at the vendor pressed the button is ours |
| **— Phase 7 —** | |
| Each gym collects into their own Razorpay account | A member's fee is the gym's money. Routing every gym's takings through one platform account would make us the party holding other businesses' money, which in India is a payment aggregator and needs an RBI licence |
| Credentials are per gym, encrypted, and write-only | AES-256-GCM, in through one service, out only as the last four characters, decrypted in two places and nowhere else |
| Connected only after Razorpay says yes | Verified by a read against their account — never by taking a payment, and never by not checking. A "connected" badge earned any other way is a guess whose first victim is a member tapping Pay |
| Each gym has its own webhook URL | Its own signing secret needs its own path. The id in the URL is opaque and random, and selects only *which* gym's secret to check the HMAC against — a wrong signature is still refused, and the ledger write is scoped by our own order row |
| The amount comes from the invoice | A browser does not get to say what is owed, and an order the gateway creates for a different amount than we asked for is abandoned rather than settled against |
| One open order per invoice | A second live order on the same invoice is how an invoice gets paid twice, so an existing one is reused |
| A frontend success message is never proof of payment | The browser hands back what Razorpay gave it; the server checks the signature and then **asks Razorpay's own API** what the status and amount actually are, and settles from that answer |
| A signed-but-false confirmation is refused | Verified by mutation: trusting the signature alone makes two tests fail |
| Settlement is idempotent at the settlement path, not just above it | A retried webhook, and the webhook-versus-browser race, both land on one captured payment and one receipt number. Also verified by mutation — and the first version of the double-pay test did **not** catch it |
| An online payment gets a receipt number | Allocated on capture, not on ordering, so the GST-relevant series stays gapless; a member who pays by UPI has the same right to a receipt as one who pays in notes |
| Pending reads as pending | "Your bank has not confirmed that yet" rather than an error page, because a few seconds of pending is a normal state and the money may well have left their account |
| An unconnected gym says so | The member app tells them to pay at the desk, which is true, rather than offering a button that opens an error |
| A gym can take all of its data out | 43 CSV files in a ZIP — members, memberships, attendance, invoices, payments, expenses, staff, classes, enquiries, stock, equipment, videos, consents and the activity log. No request to us, no waiting |
| Every table is accounted for | Each one is either exported or in an exclusions list with a stated reason, and a guard test fails if a new table is in neither. A table added next year cannot go silently missing from every export |
| Every column is checked against the schema | Prisma throws on an unknown field, so a renamed column would turn one file into a 500 for a gym trying to leave. A test compares every named column to the generated model |
| Credentials and live tokens are never exported | Sessions, door tokens, WhatsApp and Razorpay secrets are keys rather than records; staff salaries stay behind the permission gate that a bulk CSV would bypass |
| It still works when a gym has stopped paying | Which is the whole point of the read-only carve-out, and is now tested against permissions resolved exactly as the app resolves them |
| Streamed, not built in memory | Pages of 1,000 rows, deflated as they go, on a 512MB container with a 120-second request limit. 60,000 rows in about two seconds |
| The archive is verified by something that did not write it | Python's `zipfile` opens the file and checks its CRCs, in the unit suite and again on a real browser download — a ZIP that Excel refuses is a total, silent failure of an export |
| CSVs carry a byte order mark | Without it Excel on Windows reads UTF-8 as the system codepage and a Marathi member list arrives as mojibake. Tested with Devanagari, Gurmukhi and Tamil names |
| A formula in a cell is defused | A member named `=HYPERLINK(…)` is prefixed, so opening the file is not code execution on whoever opens it |
| Taking an export is audited | A download of a whole member list is worth being able to see in the activity log, with who and when |
| A member can take their own data | Their details, visits, payments, bookings, assessments and the full health declaration the gym's bulk export deliberately summarises — which is what India's DPDP Act gives them a right to |
| Workout plans | A trainer writes a week — days, exercises, sets, reps, rest, notes — and assigns it to as many members as they like. The last area of the gym portal that had tables, permissions and a sidebar entry but no software |
| A plan is a template until it is assigned | The same plan goes to forty members, and editing it changes what all forty do next session — which is what a trainer means by "I updated the beginner plan". The audit line says how many people were affected |
| A member follows one plan at a time | Two is a member who does not know what to do today. Assigning a second ends the first and the screen says what it replaced, rather than switching somebody's training silently |
| A log belongs to the member, not the plan | Days and items are replaced wholesale on an edit, so a careless cascade would delete a year of somebody's lifts because their trainer reordered a week. Verified by mutation |
| The member's screen opens on the session to do now | The day they have done least recently, skipping rest days — a plan is a rotation, not a table of contents |
| Every exercise carries what they lifted last time | That is the number somebody at a rack actually wants; "3 × 8" alone leaves them guessing at Tuesday's weight. The log form pre-fills with it, so beating it is one keystroke |
| A whole day is logged in one request | Exercise by exercise is a dozen requests from a gym floor with bad signal, and half a session recorded when one fails. Re-logging the same day replaces it, so fixing a typo does not double the session |
| Cautions follow the exercise to the member | "Skip this if your shoulder is sore" in the library and nowhere else is a caution nobody reads |
| A plan with members on it cannot be retired | It names how many and says they would open the app to nothing |
| The isolation lint rules actually run | They had never executed: nothing referenced the shared config, no package had a script that used it, and `apps/web` ran `next lint` — which prompts interactively with no config of its own, so `pnpm lint` failed every time and read as a pass |
| Every list read is bounded | 46 unbounded `findMany` calls, each now capped at what that table can plausibly hold for one gym. On a host that cuts a request off at 120 seconds, an unbounded read of a year of attendance is the request that never returns |
| A report that cannot be complete says so | Reports aggregate in JavaScript, so they cap the read **and** carry a `truncated` flag with a note telling the reader to narrow the dates. A total computed from the first 20,000 of 30,000 payments is a wrong number presented as a right one, and a gym would file it |
| Truncation takes the rows that matter | Collections oldest-first so a partial report is a complete prefix of the period; outstanding dues oldest-first so the invoices most worth chasing are the ones that arrive |
| The raw-SQL rule now matches the dangerous shape | It had flagged every `$queryRawUnsafe`, including the four parameterised `SELECT … FOR UPDATE` row locks that hold class capacity and stock — so the first person to need a lock would have silenced it wholesale. It matches interpolated template literals only, and a planted violation proves it still bites |
| **Workout suite — 28 tests** | **Including that a member sees nothing of another member's training, and that the trainer's session count agrees with the member's** |
| **— Phase 9 —** | |
| No secret can reach a repository unnoticed | A scanner over what git tracks *and over everything it ever tracked*, since a key committed and deleted is still readable with `git show`. Wired into `pnpm verify`, and tested by planting each kind of secret and checking it is caught |
| Gym registration is limited | It is public, creates a tenant with a dozen rows, and had no limit at all: one script could have filled the database on a shared host. Ten an hour per address, with a message a real gym owner can act on and no number for a script to tune against |
| The address a limit counts against cannot be chosen by the caller | `X-Forwarded-For` is read from the **right**, not the left. Taking the first entry — the obvious reading, and what this did — let anyone set their own throttle key and reduced every rate limit to decoration |
| Sign-in codes and resets are limited per connection too | The existing cooldowns were per number and per email address, which does nothing against a script walking a list — and every sign-in code that finds a real member costs the gym a WhatsApp message |
| A daily tidy-up that actually runs | Expired tokens, dead sessions, old login attempts and spent throttle counters, in bounded batches so a backlog clears over several passes rather than one request being cut off at 120 seconds |
| **pg_dump is refused by this database, and now says so** | Every tenant table has FORCE ROW LEVEL SECURITY, which applies to the owner too — so a nightly dump set up the obvious way fails every night. Dumps run as the BYPASSRLS role, restores as the owner, and the script explains the failure rather than printing a stack trace |
| A backup is verified by being restored | Into a throwaway database, comparing row counts table by table and confirming row-level security came back **enabled and forced** with its policies. A restore that loses RLS comes back up with every gym able to read every other gym's data, looking entirely healthy |
| **Throttling and housekeeping suite — 15 tests** | **Including that a refused request still counts, so sitting on a limit does not reset it** |
| **Secret scan suite — 16 tests** | **Each rule proved against a planted secret, and the near-misses that must stay allowed** |
| **Backup suite — 4 tests** | **Including that dumping without BYPASSRLS fails with an explanation** |
| **Data export suite — 16 tests, plus 4 on the archive itself** | **Including that one gym's export carries no row of another's, and that a member's carries nobody else's** |
| **Online payment suite — 23 tests** | **Including a correctly signed confirmation for a payment that never succeeded, a payment belonging to another order, and the same webhook arriving twice** |
| **Platform console suite — 26 tests** | **Including that a gym owner cannot open platform context at all, and that every platform action is readable in the gym's own log** |

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
| Razorpay checkout in the browser | The server half is built and tested; the checkout flow needs real test credentials |
| First deployment to Hostinger over HTTPS | Blocked: needs a database connection string and a GitHub repository |

### What is deliberately not in the navigation

The sidebar lists only pages that exist. Every unbuilt destination carries
`built: false` in `apps/web/app/(gym)/layout.tsx` and is hidden until its
screen lands — a menu item that 404s teaches people not to trust the menu.

As of 21 November there are none: Workouts was the last one, and the whole
gym portal is now reachable from the sidebar. The mechanism stays, because
the next unbuilt thing should be hidden rather than broken — but it is worth
noting that a hidden entry is still a feature that does not exist, and
`built: false` had quietly carried this one for weeks.

---

## Pending — later phases

Phases 2 through 9 as set out in the architecture document: core gym
management, operations, communication, member experience, commercial SaaS,
advanced integrations, native mobile, hardening.

---

## Blocked — waiting on Yogeshwar

| Blocker | Blocks | Needed by |
| --- | --- | --- |
| Razorpay test credentials (key id, key secret) | Verifying online payments end to end — the code is built and stubbed-tested, but no real order has ever been created | Before Phase 7 can close |
| Managed PostgreSQL provider decision and connection string | Any deployment | Before the first deploy |
| GitHub push access from this session | Pushing the 27 commits to `yogwalture/D-walts-fit`. The repository exists and is readable; this session's git proxy will not issue a credential for it because it is not in the session's authorised repository set. A complete bundle has been handed over instead, so the history can be pushed from your own machine | Now |
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
| `withPlatform` promised in a comment what nothing enforced | Writing the console's gym detail view | Its doc comment said it "does NOT open a gym's operational data". Nothing checked: it returned the plain client, and a stray `tx.member.findMany()` would have been answered — by an empty array, because row-level security denies it silently. So the first version of the detail page reported **every gym as having zero members, zero branches and zero staff**, and looked entirely plausible doing it. The data layer now refuses those models by name, the refusal says which call was meant, and the counts come from the job role deliberately. |
| The console's call list could silently omit the most urgent gym | Platform console suite | It read every trial and past-due subscription with a `take` and no ordering, then filtered to "ending within seven days" in memory. PostgreSQL returns rows in whatever order suits it, so with more gyms than the page size, **the gyms about to lapse could be exactly the ones dropped** — a sales list that quietly leaves people out is worse than no list, because nobody knows to check. It now narrows and orders in SQL before taking a page. |
| The console claimed a reach the database does not permit | Platform console suite | `PLATFORM_MODELS` started as a hand-reasoned guess at "platform-owned tables" and included `OrgSetting`, which the generated RLS does not grant platform context. Every owner's phone number came back null, so **the call list had no numbers to call**. The list now mirrors the policies exactly and the contact details are read, one column, through the job role. |
| `pnpm test` had never run the tests either | The same `pnpm verify` run | It ran `turbo run test`, which runs each package's own script. Only `@gym/db` had one, pointing at a directory with no test files in it — so turbo's `test` task failed while the suite I had been running by hand from the root passed. `pnpm test:isolation` was broken the same way, with `--dir` that never matched the config's include glob. Both are root commands now, and `pnpm verify` is checked by its exit code rather than by grepping its output. |
| The test suite poisoned its own next run | Running `pnpm verify` four times in an afternoon | The registration throttle counts rows that live 24 hours, so a suite registering thirty gyms exhausted the ten-an-hour allowance for whichever address it reused — and the failure landed on a different test each time. Took three attempts to pin: a per-module counter collided between files, and a random address from a small range collided by chance. Each test gym now gets an address unique to its worker, and a global setup clears the counters earlier runs left in the documentation and benchmarking ranges. |
| `pnpm lint` had never linted a line | Running `pnpm verify` for the first time | The isolation rules were written to fail the build; nothing referenced them. `apps/web` ran `next lint`, which with no config drops into an interactive prompt and exits non-zero — and I had read that as clean because I grepped its output for words like "error" instead of checking the exit status. Same mistake as the typecheck one, three days apart. Wired up, it found **46 unbounded `findMany` calls** and a `= [] = [` double assignment in code I wrote two days ago that typechecks and works by accident. |
| The last sidebar entry had nothing behind it, and I had written a false claim about it | Auditing what `fitness.workout.*` actually did | Six tables since the first migration, five permission keys seeded and granted to trainers and managers, a nav entry marked `built: false` — and no service, no screen. Worse: the data export excluded workout plans two days ago with the reason that they "stay readable and editable in the product", a sentence I wrote about software that did not exist. Third instance of this pattern, and the first where the false claim was mine. |
| The trainer's screen and the member's screen disagreed about a session | The browser run, after the unit suite passed | `listWorkoutAssignments` counted log rows, so a member who logged one six-exercise day showed up to the trainer as six sessions while their own app said one. Every unit test until then had logged a single exercise, so nothing caught it. Both count days now, and a test asserts the two agree. |
| The secret scanner failed the moment it was committed | The suite going red on the next run | Its own test file has to contain a planted example of every rule or it cannot prove the rules work — so the scanner flagged its own fixtures. It had run clean before the commit only because the file was still untracked. The exception is one exact path, and a test now pins the list at four entries so it cannot quietly grow. |
| Backups of this database did not work at all | Running `scripts/backup.mjs` for the first time | `pg_dump` is **refused outright**: every tenant table has FORCE ROW LEVEL SECURITY, which applies to the table's owner, so a dump with no organization in context fails with `query would be affected by row-level security policy for table "attendance"`. Anyone setting up a nightly dump with the owner credentials — the obvious thing — would have had a job failing every night, and found out on the day they needed it. Dumps now run as the BYPASSRLS role; the script names the problem when they do not. |
| The rate limits could be bypassed by anybody who read the code | Isolating the e2e suites from each other's throttle | `clientIp()` took the **first** entry of `X-Forwarded-For`. A proxy appends the address it received from, so the first entry is whatever the caller put there — meaning a caller could choose their own throttle key and the login, registration and sign-in-code limits were all decoration. Read from the right now, with the number of trusted proxies configured. |
| The backup verification was passing by not looking | Being suspicious of a number | It reported "14 populated tables restored" where there are 53. `n_live_tup` is an estimate maintained by autovacuum and reads 0 for a table that has rows but has not been analysed — so the comparison silently skipped exactly the tables most recently written to. Statistics are refreshed on both sides before comparing. |
| Both e2e suites poisoned their own next run | Running them twice in a row | The registration throttle counted their registrations against one address — `127.0.0.1`, which Next fills in from the socket — so the third run of the day failed at its first request. Each run now presents its own forwarded address, which doubles as the check that a caller-supplied leading entry is ignored. |
| The product promised an export that did not exist | Auditing what `org.export.create` actually did | The permission was seeded, granted to two roles, and given a **special carve-out in the permission engine** so it would survive read-only mode. The subscription page told gyms a lapsed trial means "you keep everything and can export it at any time". The platform console said a suspended gym "can still export everything". Nothing implemented an export. Every one of those sentences was true about the database and false about the product — the same failure as the audit log, found the same way: by checking whether a promise in the interface had anything behind it. |
| Three query flags meant the opposite of what they said | An e2e check that returned an empty list | `z.coerce.boolean()` applies JavaScript truthiness, so the string `"false"` — which is exactly what a query string carries — came out as `true`. `?platformOnly=false` on the audit log meant *only* platform rows; `?withStats=false` meant with stats; `?includeCancelled=false` included cancelled classes. Nothing errored, the answers were just wrong, and 15 flags across six contract files were built on it. One parser now handles all of them and refuses what it cannot read. |
| A browser check failed one run in three | Running the suite twice in a row | The branch-move check read the API as soon as the dialog closed, which says the request was sent rather than that the move had landed. It now polls. Second instance of this exact race in two days — the first was the limits panel — so it is a pattern in this suite, not an accident. |
| `pnpm typecheck` could never have passed | Running it after the console landed | Not one package had a `tsconfig.json`, so every `tsc --noEmit` printed the compiler's help text and exited 1. Turbo stopped at the first failure and the command had presumably been failing since the scaffold. **A check that cannot pass is a check nobody runs** — the real typechecking has been happening incidentally, inside `next build`, which only covers what the web app imports. Each package now has a config and all six pass. |
| Registering the second gym in the browser suite replaced the first gym's session | Platform console browser run | The Starter-plan gym was registered in a new page in the same browser context, so the session cookie became that gym's. Nothing noticed, because the run ended there. The moment a section was added after it, it was reading the wrong gym's activity log. The original owner is now signed back in explicitly. |

---

## Known limitations, stated plainly

| Limitation | Why | Mitigation |
| --- | --- | --- |
| `sessions` is deliberately outside row-level security | It is the authentication primitive: looked up by token hash before any tenant is known | Keyed by SHA-256 of a 32-byte random token; documented in `docs/SECURITY.md` |
| Background jobs run under a `BYPASSRLS` role | Cron work is legitimately cross-tenant | Reachable only from `/api/cron` behind a shared secret; never from a request path |
| Column names are camelCase while table names are snake_case | Prisma's default column mapping | Consistent and documented; the RLS generator quotes identifiers correctly |
| `prisma migrate dev` needs a shadow database | Prisma's drift detection | `shadowDatabaseUrl` on managed providers; `CREATEDB` on the owner role locally |
| Three tables sit outside row-level security | `sessions`, `login_attempts` and `throttle_hits` are all consulted before any tenant is known — by definition | None carries tenant data: a token hash, an email and an outcome, an address and a timestamp. Documented in `docs/SECURITY.md`, and swept by the housekeeping job |
| A volumetric attack is not handled in the application | A flood from a thousand addresses is an edge problem, and a database-backed counter cannot absorb it | The per-address limits stop the single script hammering one endpoint, which is the realistic abuse of a self-serve form. Volumetric defence belongs at Cloudflare or whatever sits in front, and saying so is better than pretending otherwise |
| No integration is verified | No real credentials yet, by design | Each will move to "verified" only after a real successful call |
| **Razorpay has never completed a real payment** | No test credentials exist yet | The whole flow is built and tested against a stub standing in for Razorpay at the HTTP boundary. What that cannot prove is that Razorpay's real API behaves as the stub does. One part *is* confirmed against the live API: the credential check reaches `api.razorpay.com` and correctly rejects a bad key pair with 401. Nothing else has been exercised for real — no order created, no payment captured, no webhook received from Razorpay itself, and `checkout.js` has never opened in a browser under this site's CSP |
| Nested relation reads are not caught by the platform guard | Prisma extensions see the top-level model only | Row-level security still empties them, so the data does not leak — the guard just cannot explain why the result is empty. Platform reads select named commercial columns for that reason, and the limitation is stated in the code |
| Platform-side usage counts come from the `BYPASSRLS` job role | Counting across tenants is legitimately cross-tenant, and the gym's own policies deny it | Narrowly bounded by rule and by code review: counts, and the account holder's own contact details. Never a member, a payment, a message or an attendance row |
| A platform administrator who is also a gym owner is one account | Somebody will run their own gym on the product they sell | The two sets of powers never mix: platform keys grant nothing inside a tenant, and gym keys grant nothing platform-side. Both suites assert it |
| Scripts other than Latin and Devanagari are still not covered | The embedded font is Noto Sans Devanagari, merged Latin + Devanagari. Tamil, Telugu, Kannada, Bengali, Gujarati, Urdu and emoji have no glyphs | `hasUnsupportedScript` reports them, and a test walks the BMP to keep that claim honest against the font. Adding a script means adding its range in `scripts/build-fonts.mjs` and regenerating |
| WhatsApp has never sent a message | No Meta credentials yet. The plumbing is built and tested against a stubbed provider | A gym's connection is only switched on after Meta answers a real call with its own credentials; until then messages are held, never marked sent |
| Template approval is recorded, not requested | Submitting a template to Meta needs the WhatsApp Business Management API and an approved app | A gym submits in Meta's dashboard and records the approved name here; the product never claims an approval Meta did not give |

---

## Changelog

**24 November 2026 — A password rule people can actually satisfy, and one
trial length**
Registration was turning gym owners away at the door. The password field
demanded length, mixed case, a digit and a symbol, and refused anything a
strength meter disliked — four separate ways to fail before anyone had seen
the product. The rule is now one sentence: eight characters or more. The
Zod schema, the server-side check, and the hints on register-gym,
accept-invitation and reset-password were all changed together, so the form
and the handler cannot disagree about what is acceptable.

Two checks stayed, because neither asks anything of someone typing honestly:
the breach list still refuses the few thousand passwords that are guessed
first, and a password still cannot contain the owner's own name or email.
Those catch real attacks; a symbol requirement mostly catches `Password1!`.

Trials were 14 days on three plans and 30 on Enterprise, for no reason
anyone recorded. Every plan is now seven days. `provisioning.ts` reads
`trialDays` off the plan row rather than a constant, so the live
`platform_plans` rows were updated in the same breath as the seed — four
rows, verified at 7 afterwards. The seed file alone would have changed
nothing for a gym registering today.

Merged as PR #1 (seven commits, one per file) so the host deployed once
rather than seven times. CI green: lint, types, migrations, isolation.
Verified against the live site — `minLength="8"`, the hint reads "At least
8 characters", and every plan on /register-gym now offers seven days.

**21 November 2026 — Workouts, and lint rules that had never run**
The sidebar had carried an entry marked unbuilt since the scaffold. Six
tables for it had been in the schema since the first migration, five
permission keys were seeded and granted, and nothing existed. Worse: two
days ago I excluded workout plans from the data export on the grounds that
they "stay readable and editable in the product" — a sentence about software
that did not exist. Third time this pattern has turned up here, first time
the false claim was mine.

Built now. A trainer writes a week — days, exercises, sets, reps, and notes
the member reads — and assigns it to as many members as they like. A plan is
a template, so editing it changes what everybody on it does next session and
the audit line says how many people that was. A member follows one at a
time, because two is a member who does not know what to do today. Their
screen opens on the day they have done least recently and every exercise
carries what they lifted last time, which is the number somebody at a rack
actually wants. The rule that would have lost a year of training history —
logs survive their plan being rewritten underneath them — is verified by
mutation.

Then `pnpm verify` failed, and the reason was worse than the symptom.
`packages/config/eslint.config.mjs` holds rules written to "fail the build
rather than wait to be caught in review": no unbounded `findMany`, no raw
SQL built by interpolation, no raw Prisma client in application code.
Nothing referenced that file. No package had a lint script that used it, and
`apps/web` ran `next lint`, which with no config of its own drops into an
interactive prompt and exits non-zero. So `pnpm lint` had failed every time
it ran, and I had read it as passing because I grepped its output for words
instead of checking the exit status — the same mistake as the typecheck one,
three days earlier.

Wired up, it found 46 unbounded reads. Each is capped now at what that table
can plausibly hold for one gym, which on a host that cuts a request off at
120 seconds is the difference between a slow report and one that never
returns. The four report aggregations needed more than a cap: a total
computed from the first 20,000 of 30,000 payments is a wrong number
presented as a right one, so they cap the read and carry a flag saying the
figures are partial and the dates should be narrowed. It also found a `= []
= [` double assignment in code I wrote two days ago, which typechecks and
works by accident.

One rule was itself wrong: it flagged every `$queryRawUnsafe`, including the
four parameterised `SELECT … FOR UPDATE` locks that hold class capacity and
stock under concurrent writes. The first person to need a row lock would
have switched the rule off. It matches interpolated template literals only
now, and a planted violation proves it still catches the real thing. 1,159
checks passing: 611 tests, 285 HTTP checks and 263 browser checks — and
`pnpm verify` now exits 0, twice in a row, which is a thing it had never
done.


**21 November 2026 — Workouts, and a claim I had made about them**
The sidebar had carried an entry marked unbuilt since the scaffold. Six
tables for it had been in the schema since the first migration, five
permission keys were seeded and granted to trainers and managers, and
nothing existed — no service, no screen. Worse than nothing: two days ago I
excluded workout plans from the data export on the grounds that they "stay
readable and editable in the product", which was a sentence about software
that did not exist. Third time this pattern has turned up in this codebase,
and the first time the false claim was mine.

It is built. A trainer writes a week — days, exercises, sets, reps, rest,
and notes the member will read — and assigns it to as many members as they
like. A plan is a template, so editing it changes what everybody on it does
next session, and the audit line says how many people that was. A member
follows one plan at a time, because two is a member who does not know what
to do today; assigning a second ends the first and the screen says what it
replaced.

The member's side opens on the day they have done least recently, skipping
rest days, because a plan is a rotation rather than a table of contents. Every
exercise carries what they lifted last time and the log form pre-fills with
it: that is the number somebody standing at a rack actually wants, and it
makes beating it one keystroke. A whole day is logged in one request, and
re-logging a day replaces it, so correcting a typo does not double the
session.

The load-bearing rule — a member's logs survive their plan being rewritten
underneath them — is verified by mutation: days and items are replaced
wholesale on an edit, so a careless cascade would delete a year of somebody's
lifts because their trainer reordered a week.

Two bugs found by the verification layers rather than by reading. The
trainer's screen counted log rows where the member's screen counted days, so
one six-exercise session showed up as six — every unit test until then had
logged a single exercise, and the browser run is what noticed. And the
secret scanner failed the moment it was committed, because its own fixtures
trip every rule it has; it had run clean beforehand only because the file was
still untracked. 1,156 checks passing: 608 tests, 285 HTTP checks and 263
browser checks.


**19 November 2026 — Hardening, and a backup that did not work**
Four things, and the second one is the one that mattered.

A secret scanner, because "never put credentials in GitHub" is a rule
somebody has to remember and the one time it is forgotten is the time it
counts. It reads what git tracks *and everything git ever tracked*, since a
key committed and then deleted is still there for anybody who runs `git
show`. Each rule is tested by planting the thing it is meant to catch, and
the near-misses that must stay allowed are tested too — the first version
flagged a megabyte of base64-inlined PDF fonts as a Meta token, and a
scanner that cries wolf gets switched off.

Then: **backups of this database did not work.** `pg_dump` is refused
outright, because every tenant table has FORCE ROW LEVEL SECURITY and that
applies to the table's owner as well. A nightly dump set up with the owner
credentials — the obvious thing to do — would have failed every night, and
anyone not reading the cron mail would have found out on the day they needed
it. Dumps now run as the BYPASSRLS role and restores as the owner, and the
script explains that specific failure rather than printing a stack trace.
`pnpm backup:verify` restores into a throwaway database, compares row counts
table by table, and checks that row-level security came back enabled and
forced with its policies — because a restore that loses RLS comes back up
with every gym able to read every other gym's data, looking perfectly
healthy. That verification was itself passing by not looking: it reported 14
populated tables where there are 53, because `n_live_tup` reads 0 for a
table that has rows but has not been analysed.

Registration was public, created a tenant with a dozen rows, and had no
limit at all. It has one now — and isolating the e2e suites from each other's
throttle exposed something worse: `clientIp()` took the **first** entry of
X-Forwarded-For. A proxy appends the address it received from, so the first
entry is whatever the caller put in the header. Anybody who read the code
could choose their own throttle key, which made the login, registration and
sign-in-code limits decoration. Read from the right now, with the number of
trusted proxies configured and the consequence of getting it wrong written
down in both directions.

And the daily tidy-up: `purgeExpiredTokens` had been written with a comment
saying a daily job ran it, and no such job existed, so expired sign-in codes
accumulated for ever. 1,095 checks passing: 576 tests, 271 HTTP checks and
248 browser checks.


**19 November 2026 — The export the product had already promised**
`org.export.create` was seeded, granted to two roles, and carved out of
read-only mode in the permission engine so a gym that stopped paying could
still use it. The subscription page told them a lapsed trial means "you keep
everything and can export it at any time". The platform console said a
suspended gym "can still export everything". And nothing implemented an
export. Every one of those sentences was true about the database and false
about the product — the same shape of failure as the audit log, found the
same way: by asking whether a promise in the interface had anything behind
it.

It does now. 43 CSV files in a ZIP, streamed a thousand rows at a time
because the deploy target gives a request 120 seconds and the container
512MB; 60,000 rows take about two seconds. Every table is either in the
export or in an exclusions list with a reason somebody can argue with, and a
guard test fails if a new table is in neither — so the table added next year
cannot quietly go missing. Another guard checks every named column against
the generated schema, because Prisma throws on an unknown field and the
person who would find that out is a gym owner trying to leave.

The archive is opened by something that did not write it — Python's zipfile,
in the unit suite and again on a real browser download — because a ZIP that
Excel refuses is a total and silent failure of the whole feature. The CSVs
carry a byte order mark, without which Excel on Windows turns a Marathi
member list into mojibake, and a cell beginning with `=` is defused so
opening the file is not code execution.

What is deliberately left out is stated on the page rather than discovered:
credentials and live tokens, because they are keys rather than records;
staff salaries, because a bulk CSV is the one place that permission gate
would not hold; and members' medical notes in full, which go to the member in
their own export instead, since a medical note is theirs before it is the
gym's. That member export is a button on their own screen, which is what
India's DPDP Act asks for and what a gym on this software should be able to
honour without emailing us.

Separately, three query flags meant the opposite of what they said.
`z.coerce.boolean()` applies JavaScript truthiness, so the string "false" is
`true` — `?platformOnly=false` on the audit log meant *only* platform rows.
Fifteen flags across six contract files were built on it. One parser now
handles all of them and refuses what it cannot read. 1,043 checks passing:
542 tests, 253 HTTP checks and 248 browser checks.


**19 November 2026 — Taking money online, and whose money it is**
The server half of Razorpay was built and tested in Phase 2; nothing created
an order, so none of it could run. It does now — and the first decision was
commercial rather than technical. A member's fee is the gym's money, so each
gym connects **their own** Razorpay account and the fee settles into their
own bank. Putting every gym's takings through one platform account would
have been less work and would have made us the party holding several hundred
other businesses' money, which in India is a payment aggregator and needs an
RBI licence. Per-gym accounts also mean per-gym signing secrets, so each gym
gets its own webhook URL; the id in that URL is opaque and decides nothing,
it only says whose secret to check the HMAC against.

The rule that shaped the rest: a frontend payment success message is never
proof of payment. The browser gets exactly one power — to open checkout
against an order we created — and none at all to tell us what happened. It
hands back what Razorpay gave it; the server checks the signature, which an
attacker cannot forge without the gym's secret, and then, because a valid
signature proves only that the handoff came from Razorpay and not what it
says, asks Razorpay's own API what the status and amount actually are and
settles from that. Two mutation checks confirm it: trusting the signature
alone makes two tests fail.

A third mutation check found a real gap. The double-pay test passed with the
idempotency guard removed, because `confirmOnlinePayment` short-circuits on
an already-captured row and never reaches the settlement path — so the test
was proving the wrong guard. The retried-webhook case, which is the one
Razorpay actually generates, now has its own test, and removing the guard
fails it.

Online payments also now get a receipt number, allocated on capture rather
than on ordering so the GST series stays gapless. A member paying by UPI has
the same right to a receipt as one paying in notes, and a series that
quietly omits online takings does not reconcile.

What is **not** done: no real payment has ever been taken. Everything is
tested against a stub standing in for Razorpay. One part is confirmed
against the live API — the credential check reaches api.razorpay.com and
correctly rejects a bad key pair — and nothing else. That stays recorded as
unverified until real test keys exist. 991 checks passing: 519 tests, 234
HTTP checks and 238 browser checks.


**19 November 2026 — The console, and a comment that was not a boundary**
Running this as a business needs a different question answered than running
a gym: not "how are we doing today" but "who do I ring". A count of three
gyms past due cannot be phoned, so the console now opens on a call list —
trials ending, invoices unpaid, gyms gone read-only — each with the owner's
name and number, soonest-to-lose first, and each gym has a page showing what
they pay, what they use against their plan and what we have invoiced them.
Two levers sit on it, because "another week to decide" and "we agreed six
sites at that price" should not mean asking an engineer: both are capped,
both demand a reason, and both write that reason into the gym's own audit
log.

Building the detail view found the real problem. `withPlatform` carried a
comment saying it "does NOT open a gym's operational data" — and nothing
enforced it. Row-level security denies those tables to platform context
silently, by returning nothing, so the first version of the page reported
**every gym as having zero members, zero branches and zero staff** and
looked entirely plausible doing it. Three things changed: the data layer now
refuses a gym's models by name and the error says which call was meant;
platform context will not open at all for somebody who is not active
platform staff, so the route guard is no longer the only thing standing
there; and the counts come from the job role deliberately, under a stated
rule — counts and the account holder's own contact details, nothing else.
The same silence had already made the call list useless in a quieter way:
every owner's phone number was null, because `OrgSetting` is not a table the
policies grant.

Then the part that makes the whole boundary worth anything: a gym can now
read its own activity log, with a view showing only what the software
company did. Every claim in this codebase that support "writes a row the
owner can see" was, until today, a sentence in a file the owner cannot open.
948 checks passing: 496 tests, 221 HTTP checks and 231 browser checks.


**18 November 2026 — Branches, and an owner locked into one of them**
The Growth plan is sold on two branches and nothing in the product could
add a second one, so the plan limit had nothing to limit. Branches are now
added from Settings, the limit is enforced in the service with the plan
named in the refusal, and the main branch is never silently reassigned
because it is the fallback everywhere. Moving a membership between branches
— built and tested in Phase 2, with no screen — now sits on the
subscriptions row, and only appears for a plan that permits it: offering it
otherwise would have put the refusal after the receptionist had already
typed a reason in front of the member.

Adding the second branch exposed the cause of the rota bug from earlier
today. Registration put the owner on the main branch, and a branch row
narrows every operational grant from ALL to BRANCH. So **an owner who opened
a second branch could not register a member there, could not see staff
outside their own branch, and could not move a membership into it.** The
owner now belongs to no branch, which is what organization-wide means
everywhere else in the permission engine. 735 checks passing: 402 tests,
162 HTTP checks and 171 browser checks.

**18 November 2026 — Reports, and the difference between watching and filing**
The dashboard answers "how are we doing". Reports answer "what do I give the
accountant", which has a different tolerance for being approximately right:
a GST return is filed by rate, so the summary is built from the invoice
lines by rate, and the CGST/SGST split comes from each rate's own components
rather than halving the tax — halving is wrong the moment a gym makes an
inter-state supply. What is owed is grouped by member rather than by
invoice, because a gym rings a person. Every report downloads as a CSV built
from the same service as the screen, so the file and the page cannot
disagree; every cell is quoted, and a cell starting with `=` is defused,
because a formula in an exported name is an attack on whoever opens the
file. 709 checks passing: 393 tests, 156 HTTP checks and 162 browser checks.

**18 November 2026 — The rota, and a trainer who was invisible**
Staff attendance, shifts and leave are one thing rather than three: approving
leave writes the attendance for those days, so the register does not show a
sanctioned absence as an unexplained one and whoever runs payroll does not
dock a day the gym already agreed to. A day already marked present is left
alone. Nobody approves their own leave — the owner holds every permission in
the gym and still cannot sanction their own absence.

Building the rota screen surfaced a bug of the same family as the import
that gave members no branch. A gym owner is put on the main branch at
registration, which narrows their permissions to branch scope; the rota then
required a branch row to list somebody, and the invitation form does not ask
for one. So **a trainer who had accepted their invitation never appeared on
the rota at all** — could not be marked in, could not be given a shift.
Somebody with no branch works for the whole gym and is now listed as such.
The browser suite now also accepts the invitation the way the invitee would,
from the link in their email, which is what caught it. 671 checks passing:
374 tests, 146 HTTP checks and 151 browser checks.

**18 November 2026 — The shop, and stock that explains itself**
What a gym sells over the counter is a taxable supply, so a counter sale
raises a real GST invoice in the same gapless series as a membership and the
money lands in the same till figure — one set of documents to reconcile
rather than two. Stock is a ledger: every change writes a movement carrying
the balance it left behind, a correction is a signed difference rather than
a new total typed over the old one, and wastage needs a reason, because
stock leaving without a sale is otherwise indistinguishable from theft. The
last protein bar is the same race as the last place in a class and is held
the same way — two tills, one unit, one sale. 626 checks passing: 353 tests,
139 HTTP checks and 141 browser checks.

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

**21 November 2026 — The repository, and what "deploy" is still waiting on**
Branch renamed `master` → `main`, because both the CI trigger and the deploy
gate name `main` and neither would ever have fired. CI now scans for secrets
before it does anything else, over tracked files and then over every commit —
which needs `fetch-depth: 0`, since a shallow clone would let a key that was
committed and later removed pass unseen. The deployment document gained a
repository section: the remote, the one GitHub Actions secret
(`DIRECT_DATABASE_URL`), and the `production` environment that must exist so
a push to `main` cannot apply migrations to a live database unattended.

The push itself did not happen. This session's git proxy refuses to issue a
credential for `yogwalture/D-walts-fit` because the repository is not in the
session's authorised set — read access works, write access does not, and the
capability the proxy names for fixing that is not available here. So the
history was handed over as a git bundle instead: 27 commits, every author and
date intact, pushed from your own machine in three commands. Nothing has been
deployed, and nothing has been overwritten.

**21 November 2026 — The trap a managed database would have set**
Going live means moving off the database I built myself onto one a provider
builds its own way, and that turned up a failure mode worth more than the
deploy it was blocking.

`BYPASSRLS` does not leak through role membership — a role that merely
belongs to a `BYPASSRLS` role reads nothing. But it can `SET ROLE` to that
role, and then it reads everything. Tested, not assumed: against PostgreSQL
16, a member of a `BYPASSRLS` role returned 0 rows from a `FORCE ROW LEVEL
SECURITY` table with a deny-all policy, and returned every row one
`SET ROLE` later.

Neon grants `neon_superuser`, which carries `BYPASSRLS`, to every role made
through its console, API or CLI. Create `gym_app` that way and `rolbypassrls`
on the role is still false, every policy is intact, the isolation suite
passes — and the application is one statement from reading every gym in the
database. The check that was already there asked what the role *is*. It
needed to ask what the role can *become*.

So: a new isolation test asserting the application role is a member of no
`BYPASSRLS` or superuser role, and `pnpm preflight` — ten read-only checks to
run against the real production database before the first deploy, covering
role escalation, RLS enabled *and* forced, policies present, an actual
zero-row read as the application's own role with no tenant in context,
migrations applied and not rolled back, and TLS on the wire. Both were
mutation-tested: granting `gym_app` membership in `gym_jobs` makes the test
fail naming `gym_jobs`, and makes preflight exit 1. 41 isolation checks now,
up from 40 — measured both ways round, because I had written 42 from memory
and the suite says otherwise.

Still not pushed and still not live. Both for the same two reasons as before:
this session's git proxy will not issue a credential for the repository, and
there is no production database to point any of this at yet.

**21 November 2026 — A limitation that was not one, and a box nobody saw**
The PDF renderer carried a comment headed "KNOWN LIMITATION, stated plainly:
pdfkit does not shape complex scripts", and this document repeated it. It was
wrong. pdfkit lays out through fontkit, which runs the Indic shaper; given a
font with the glyphs it renders Devanagari correctly, reph and conjuncts and
all. The font was DejaVu Sans, which has no Devanagari in it whatsoever. The
problem was coverage, and it had been written down as a shaping problem, which
is why it sat untouched for weeks as something that needed "a different
renderer". It needed a different font.

Worse: `hasUnsupportedScript`, named in this document as the mitigation — "so
it can be reported rather than printed as boxes" — was exported and **called
by nothing**. A gym in Chhatrapati Sambhajinagar recording a member as
रवी कुलकर्णी would have been handed a receipt of hollow boxes, silently.

So the font is now Noto Sans Devanagari with its Latin and Devanagari subsets
merged into one file: one font covering both scripts, so none of the fifty-odd
text calls across the two renderers has to know which script it is drawing.
Gzipped and inlined, 131 KB for the pair.

Then, rendering a real invoice to look at it turned up a bug older than any of
this. The totals block prints `−` U+2212, the true minus sign, on the discount
and payment rows. It was in neither the old font subset nor the allow-list, so
**every invoice that recorded a payment has printed a hollow box next to the
amount since the invoice shipped in Phase 2**. Nothing caught it: the allow-list
was self-consistent, the font was self-consistent, and the character came from
a template literal in between the two.

Three tests now hold this down, each mutation-tested: the font's own cmap is
parsed and checked for Devanagari consonants, matras, the virama, ळ and the
digits; every codepoint the allow-list accepts must have a glyph in both
weights, so the two cannot drift; and every non-ASCII character the renderer
sources themselves contain must be one the font can draw, which is the check
that would have caught the minus sign. 631 checks passing, up from 611.

Not deployed, and not pushed. The push still needs one command run on the
Mac — `cd ~/Downloads && bash push-to-github.command` — because the download
stripped the file's executable bit and this session may not type into a
terminal.
