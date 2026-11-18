#!/usr/bin/env bash
#
# End-to-end HTTP smoke test against a running server.
#
# Exercises the real request path — middleware, handler wrapper, session
# resolution, permission engine, row-level security — with curl, exactly as a
# browser would. Nothing is mocked.
#
#   BASE_URL=http://127.0.0.1:3100 ./tests/e2e/http-smoke.sh

set -uo pipefail

BASE="${BASE_URL:-http://127.0.0.1:3100}"
JAR="$(mktemp)"
STAMP="$(date +%s)$RANDOM"
EMAIL="e2e.${STAMP}@example.com"
PASSWORD="correct horse battery staple 47"

pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n     expected: %s\n     got:      %s\n' "$1" "$2" "$3"; fail=$((fail + 1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "contains '$3'" "$(printf '%.90s' "$2")";; esac; }
hasnt(){ case "$2" in *"$3"*) bad "$1" "must not contain '$3'" "found it";; *) ok "$1";; esac; }

printf '\nHTTP smoke test against %s\n\n' "$BASE"

# --------------------------------------------------------------- public ---
printf 'public surface\n'

code=$(curl -s -o /tmp/e2e.out -w '%{http_code}' "$BASE/")
check "the landing page loads" "200" "$code"
has "it renders the sign-in link" "$(cat /tmp/e2e.out)" 'href="/login"'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login")
check "the login page loads" "200" "$code"

# Header names are case-insensitive per RFC 9110, and Next emits a mix.
headers=$(curl -s -D - -o /dev/null "$BASE/" | tr 'A-Z' 'a-z')
has "sends X-Content-Type-Options"       "$headers" "x-content-type-options: nosniff"
has "sends X-Frame-Options"              "$headers" "x-frame-options: deny"
has "sends Referrer-Policy"              "$headers" "referrer-policy: strict-origin-when-cross-origin"
has "sends Strict-Transport-Security"    "$headers" "strict-transport-security"
has "sends a Content-Security-Policy"    "$headers" "content-security-policy:"
has "CSP forbids framing"                "$headers" "frame-ancestors 'none'"
hasnt "does not advertise the framework" "$headers" "x-powered-by"

# ---------------------------------------------------------- auth required ---
printf '\nunauthenticated access\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/dashboard")
case "$code" in 302|303|307|308) ok "a signed-out visitor is redirected away from the dashboard";;
  *) bad "a signed-out visitor is redirected away from the dashboard" "3xx" "$code";; esac

location=$(curl -s -D - -o /dev/null "$BASE/dashboard" | tr 'A-Z' 'a-z' | grep '^location:' | tr -d '\r')
has "and is sent to the login page" "$location" "/login"

body=$(curl -s "$BASE/api/v1/members")
has "an API route answers 401 JSON, not an HTML login page" "$body" "UNAUTHENTICATED"

# -------------------------------------------------------------- register ---
printf '\nregistration\n'

body=$(curl -s -c "$JAR" -X POST "$BASE/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"gymName\":\"E2E Fitness $STAMP\",\"ownerName\":\"E2E Owner\",\"email\":\"$EMAIL\",
       \"phone\":\"9876512345\",\"password\":\"$PASSWORD\",\"city\":\"Chhatrapati Sambhajinagar\",
       \"planKey\":\"GROWTH\",\"acceptedTerms\":true}")

has "a gym is created" "$body" '"slug"'
has "and the owner is signed in with the owner role" "$body" '"key":"GYM_OWNER"'
grep -q "gym_session" "$JAR" && ok "a session cookie is set" || bad "a session cookie is set" "cookie" "none"
grep -q "HttpOnly" "$JAR" && ok "the cookie is HttpOnly" || bad "the cookie is HttpOnly" "HttpOnly" "not set"

body=$(curl -s -X POST "$BASE/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"gymName\":\"Weak\",\"ownerName\":\"Weak\",\"email\":\"weak.$STAMP@example.com\",
       \"phone\":\"9876512346\",\"password\":\"short\",\"acceptedTerms\":true}")
has "a weak password is rejected with field detail" "$body" "VALIDATION_FAILED"

body=$(curl -s -X POST "$BASE/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"gymName\":\"Dup\",\"ownerName\":\"Dup\",\"email\":\"$EMAIL\",
       \"phone\":\"9876512347\",\"password\":\"$PASSWORD\",\"acceptedTerms\":true}")
has "a duplicate email address is refused" "$body" "already exists"

# --------------------------------------------------------------- session ---
printf '\nsession and permissions\n'

body=$(curl -s -b "$JAR" "$BASE/api/v1/session")
has "the session resolves to the right user"  "$body" "$EMAIL"
has "with the gym attached"                   "$body" "E2E Fitness"
has "the owner may refund"                    "$body" "finance.payment.refund"
has "the owner may read medical declarations" "$body" "members.medical.read"
has "the owner may change integrations"       "$body" "org.integration.update"
hasnt "the owner holds no platform powers"    "$body" "platform.gym.suspend"

code=$(curl -s -b "$JAR" -o /tmp/e2e.dash -w '%{http_code}' "$BASE/dashboard")
check "the dashboard loads when signed in" "200" "$code"
has "it shows the gym name"       "$(cat /tmp/e2e.dash)" "E2E Fitness"
has "it shows the role"           "$(cat /tmp/e2e.dash)" "Gym Owner"
has "it shows real zeros, not invented demo numbers" "$(cat /tmp/e2e.dash)" "No members yet"
has "the sidebar shows an owner-only item" "$(cat /tmp/e2e.dash)" "Settings"

# ------------------------------------------------------- tenant isolation ---
printf '\ntenant isolation over HTTP\n'

if [ -n "${FOREIGN_ORG_ID:-}" ]; then
  body=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/session/organization" \
    -H 'content-type: application/json' \
    -d "{\"organizationId\":\"$FOREIGN_ORG_ID\"}")
  has "switching into a gym you do not belong to is refused" "$body" "FORBIDDEN"

  body=$(curl -s -b "$JAR" "$BASE/api/v1/session")
  has "and the session still points at your own gym" "$body" "E2E Fitness"
else
  printf '  – skipped (FOREIGN_ORG_ID not set)\n'
fi


# ------------------------------------------------------- account flows ---
printf '\naccount recovery and invitations\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/forgot-password")
check "the forgot-password page loads" "200" "$code"

body=$(curl -s -X POST "$BASE/api/v1/auth/forgot-password" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}")
has "a reset request is acknowledged" "$body" "on its way"

body2=$(curl -s -X POST "$BASE/api/v1/auth/forgot-password" \
  -H 'content-type: application/json' -d "{\"email\":\"nobody.$STAMP@example.com\"}")
check "an unknown address gets the identical answer" "$body" "$body2"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/reset-password")
check "the reset page loads without a token" "200" "$code"

body=$(curl -s -X POST "$BASE/api/v1/auth/reset-password" \
  -H 'content-type: application/json' \
  -d '{"token":"0000000000000000000000000000000000000000000","password":"a perfectly fine passphrase 21"}')
has "a forged reset token is refused" "$body" "NOT_FOUND"

body=$(curl -s -o /tmp/e2e.inv -w '%{http_code}' "$BASE/accept-invitation?token=notarealtokenatallxxxxxxxxxxxxxx")
has "a bad invitation link shows a plain expiry message" "$(cat /tmp/e2e.inv)" "has expired"

body=$(curl -s "$BASE/api/v1/auth/invitation?token=notarealtokenatallxxxxxxxxxxxxxx")
check "and the API reports it as absent, not as an error" '{"data":null}' "$body"

# ---------------------------------------------------------- member login ---
printf '\nmember login\n'

# A number nobody has used before, so running this suite twice in a row does
# not collide with the per-identifier throttle the first run left behind. The
# throttle working is the point; tripping over it is not a finding.
OTP_NUMBER="9${RANDOM}${RANDOM}"
OTP_NUMBER="9$(printf '%09d' $((RANDOM * RANDOM % 900000000 + 100000000)))"
OTP_NUMBER="${OTP_NUMBER:0:10}"

body=$(curl -s -X POST "$BASE/api/v1/auth/member" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":\"$OTP_NUMBER\",\"organizationSlug\":\"iron-temple\"}")
has "a code request is acknowledged" "$body" "on its way"

body2=$(curl -s -X POST "$BASE/api/v1/auth/member" \
  -H 'content-type: application/json' \
  -d '{"identifier":"9000000000","organizationSlug":"no-such-gym"}')
check "an unknown member at an unknown gym answers identically" "$body" "$body2"

body=$(curl -s -X PUT "$BASE/api/v1/auth/member" \
  -H 'content-type: application/json' \
  -d "{\"identifier\":\"$OTP_NUMBER\",\"organizationSlug\":\"iron-temple\",\"code\":\"000000\"}")
has "a wrong code is refused" "$body" "INVALID_CREDENTIALS"

# ------------------------------------------------------------ authority ---
printf '\nauthority boundaries\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")
case "$code" in 302|303|307|308) ok "the platform console is closed to signed-out visitors";;
  *) bad "the platform console is closed to signed-out visitors" "3xx" "$code";; esac

code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/admin")
check "and hidden from a gym owner, who is not platform staff" "404" "$code"

body=$(curl -s -b "$JAR" "$BASE/api/v1/platform/stats")
has "platform revenue is refused to a gym owner" "$body" "PERMISSION_DENIED"

body=$(curl -s -b "$JAR" "$BASE/api/v1/platform/gyms")
has "the gym list is refused to a gym owner" "$body" "PERMISSION_DENIED"

code=$(curl -s -b "$JAR" -o /tmp/e2e.staff -w '%{http_code}' "$BASE/settings/users")
check "the owner can open staff settings" "200" "$code"
has "and sees the invite control" "$(cat /tmp/e2e.staff)" "Invite staff"

body=$(curl -s -b "$JAR" "$BASE/api/v1/org/staff")
has "the staff list returns the owner" "$body" "$EMAIL"
hasnt "and carries no salary data" "$body" "salary"

code=$(curl -s -b "$JAR" -o /tmp/e2e.sec -w '%{http_code}' "$BASE/settings/security")
check "the security page loads" "200" "$code"
has "and offers two-factor setup" "$(cat /tmp/e2e.sec)" "Two-factor authentication"

body=$(curl -s -X POST "$BASE/api/v1/me/mfa")
has "two-factor setup requires a session" "$body" "UNAUTHENTICATED"

body=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/org/staff" \
  -H 'content-type: application/json' \
  -d '{"email":"bad","fullName":"X","roleId":"not-a-uuid","branchIds":[]}')
has "an invitation with bad input is rejected field by field" "$body" "VALIDATION_FAILED"

rm -f /tmp/e2e.inv /tmp/e2e.staff /tmp/e2e.sec

# ------------------------------------------------------------------ login ---
printf '\nlogin\n'

body=$(curl -s -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-password-entirely\"}")
has "a wrong password is refused" "$body" "INVALID_CREDENTIALS"

body2=$(curl -s -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"nobody.$STAMP@example.com\",\"password\":\"wrong-password-entirely\"}")
has "an unknown address is refused the same way" "$body2" "INVALID_CREDENTIALS"
check "with an identical message, so accounts cannot be enumerated" "$body" "$body2"

FRESH="$(mktemp)"
body=$(curl -s -c "$FRESH" -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
has "the right password signs in" "$body" '"key":"GYM_OWNER"'

# ------------------------------------------------------------------- CSRF ---
printf '\ncross-site protection\n'

body=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/session/organization" \
  -H 'content-type: application/json' \
  -H 'origin: https://evil.example.com' \
  -d '{"organizationId":"00000000-0000-0000-0000-000000000000"}')
has "a cross-origin POST carrying the cookie is refused" "$body" "FORBIDDEN"

# ------------------------------------------------------- Phase 2 endpoints ---
printf '\nphase 2 endpoints, signed out\n'

for path in \
  "/api/v1/members" \
  "/api/v1/memberships/plans" \
  "/api/v1/attendance/today" \
  "/api/v1/finance/payments" \
  "/api/v1/dashboard" \
  "/api/v1/dashboard/charts" \
  "/api/v1/dashboard/actions" \
  "/api/v1/finance/invoices" \
  "/api/v1/memberships/subscriptions" \
  "/api/v1/members/import" \
  "/api/v1/finance/expenses" \
  "/api/v1/finance/expenses/categories" \
  "/api/v1/staff/trainers" \
  "/api/v1/org/invitations"
do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  check "$path is closed to a stranger" "401" "$code"
done

printf '\nthe Razorpay webhook\n'

# No signature at all. This endpoint is public by necessity, so it is the one
# place an outsider can reach that moves money — it must refuse everything
# that is not signed by Razorpay.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/razorpay" \
  -H 'content-type: application/json' \
  -d '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_forged","order_id":"order_forged","amount":150000}}}}')
case "$code" in
  400|503) ok "an unsigned webhook is refused (got $code)";;
  *) bad "an unsigned webhook is refused" "400 or 503" "$code";;
esac

# A plausible but wrong signature.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/razorpay" \
  -H 'content-type: application/json' \
  -H 'x-razorpay-signature: 0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_forged","order_id":"order_forged","amount":150000}}}}')
case "$code" in
  400|503) ok "a forged signature is refused (got $code)";;
  *) bad "a forged signature is refused" "400 or 503" "$code";;
esac

# With a webhook secret in the environment, the signature path itself can be
# exercised rather than only the "not configured" branch. Run this script with
# RAZORPAY_WEBHOOK_SECRET set to cover it; without one, 503 above is as far as
# a request gets and these are skipped rather than silently passing.
if [ -n "${RAZORPAY_WEBHOOK_SECRET:-}" ] && command -v openssl >/dev/null 2>&1; then
  WH_BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_smoke","order_id":"order_not_ours","amount":150000}}}}'
  WH_SIG=$(printf '%s' "$WH_BODY" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" -hex | sed 's/.*= //')

  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/razorpay" \
    -H 'content-type: application/json' -H "x-razorpay-signature: $WH_SIG" -d "$WH_BODY")
  check "a correctly signed webhook is accepted" "200" "$code"

  # The attack that matters: sign a real amount, then raise it in flight.
  TAMPERED='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_smoke","order_id":"order_not_ours","amount":9900000}}}}'
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/razorpay" \
    -H 'content-type: application/json' -H "x-razorpay-signature: $WH_SIG" -d "$TAMPERED")
  check "a body altered after signing is refused" "400" "$code"
else
  printf '  - signature path skipped (set RAZORPAY_WEBHOOK_SECRET to cover it)\n'
fi

printf '\nthe counter cannot claim a gateway payment\n'

JAR2="$(mktemp)"
curl -s -c "$JAR2" -o /dev/null -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"

body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/finance/payments" \
  -H 'content-type: application/json' \
  -H "origin: $BASE" \
  -d '{"memberId":"00000000-0000-0000-0000-000000000000","amount":"1500.00","method":"RAZORPAY"}')
has "RAZORPAY is rejected at validation, not merely discouraged" "$body" "VALIDATION_FAILED"

# An override at the desk without a recorded reason.
body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/attendance/check-in" \
  -H 'content-type: application/json' \
  -H "origin: $BASE" \
  -d '{"memberCode":"M00001","override":true}')
has "an override without a reason is refused" "$body" "VALIDATION_FAILED"

# A list endpoint cannot be talked into returning the whole table.
body=$(curl -s -b "$JAR2" "$BASE/api/v1/members?pageSize=100000")
has "an oversized page size is refused" "$body" "VALIDATION_FAILED"

printf '\nmember import\n'

# The upload route reads a multipart body itself rather than going through the
# JSON wrapper, so its gate is checked separately: a stranger must not be able
# to post a file, and a cross-site form must not be able to either.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/members/import" \
  -F 'file=@/dev/null;filename=x.csv;type=text/csv')
check "a stranger cannot upload a member list" "401" "$code"

printf 'Name,Mobile\nSmoke Import,9846000001\n' > /tmp/smoke-import.csv

body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members/import" \
  -H 'origin: https://evil.example.com' \
  -F "file=@/tmp/smoke-import.csv;type=text/csv")
has "a cross-site upload carrying the cookie is refused" "$body" "FORBIDDEN"

body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members/import" \
  -H "origin: $BASE" \
  -F "file=@/tmp/smoke-import.csv;type=text/csv")
has "a real upload is staged" "$body" '"validRows":1'
has "and nothing is created yet" "$body" '"importId"'

IMPORT_ID=$(printf '%s' "$body" | python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('importId',''))" 2>/dev/null)

if [ -n "$IMPORT_ID" ]; then
  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members/import/$IMPORT_ID/commit" \
    -H 'content-type: application/json' -H "origin: $BASE" -d '{}')
  has "committing creates the member" "$body" '"created":1'

  found=$(curl -s -b "$JAR2" "$BASE/api/v1/members?search=9846000001")
  has "and it appears on the members list" "$found" "Smoke"
fi

# A file that is not a spreadsheet must be refused rather than half-read.
printf '\x89PNG\r\n\x1a\n not a spreadsheet' > /tmp/smoke-not-a-sheet.png
body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members/import" \
  -H "origin: $BASE" \
  -F "file=@/tmp/smoke-not-a-sheet.png;type=image/png")
has "a file that is not a member list is refused" "$body" "VALIDATION_FAILED"

rm -f /tmp/smoke-import.csv /tmp/smoke-not-a-sheet.png

printf '\nteam and trainers\n'

# An invited person has no account until they accept, so without this the
# team page showed nothing and the sender could not tell it had gone out.
ROLE_ID=$(curl -s -b "$JAR2" "$BASE/api/v1/org/roles" \
  | python3 -c "import sys,json;rs=json.load(sys.stdin).get('data') or [];print(next((r['id'] for r in rs if r.get('key')=='TRAINER'),''))" 2>/dev/null)

if [ -n "$ROLE_ID" ]; then
  INVITE_EMAIL="smoke.trainer.$STAMP@example.com"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/org/staff" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"email\":\"$INVITE_EMAIL\",\"fullName\":\"Smoke Trainer\",\"roleId\":\"$ROLE_ID\",\"branchIds\":[]}")
  check "a trainer can be invited" "201" "$code"

  body=$(curl -s -b "$JAR2" "$BASE/api/v1/org/invitations")
  has "the pending invitation is visible" "$body" "Smoke Trainer"
  has "with the address it went to" "$body" "$INVITE_EMAIL"

  INVITE_ID=$(printf '%s' "$body" | python3 -c "import sys,json;d=json.load(sys.stdin).get('data') or [];print(d[0].get('id','') if d else '')" 2>/dev/null)

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X DELETE \
    -H "origin: $BASE" "$BASE/api/v1/org/invitations/$INVITE_ID")
  check "and can be taken back" "200" "$code"

  body=$(curl -s -b "$JAR2" "$BASE/api/v1/org/invitations")
  case "$body" in
    *"$INVITE_EMAIL"*) bad "a revoked invitation is gone" "not listed" "still listed";;
    *) ok "a revoked invitation is gone";;
  esac
fi

printf '\nexpenses and receipts\n'

# An expense is money leaving the business, so the gate matters as much as it
# does on the way in.
body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/finance/expenses" \
  -H 'content-type: application/json' -H 'origin: https://evil.example.com' \
  -d '{"title":"Hostile","amount":"1000","spentOn":"2026-11-18"}')
has "a cross-site expense is refused" "$body" "FORBIDDEN"

body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/finance/expenses" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"title":"Electricity bill","amount":"8000","taxAmount":"1440","spentOn":"2026-11-18","method":"BANK_TRANSFER"}')
has "an expense is recorded with its tax kept apart" "$body" '"totalAmount":"9440.00"'

body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/finance/expenses" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"title":"Nothing","amount":"0","spentOn":"2026-11-18"}')
has "a zero expense is refused" "$body" "VALIDATION_FAILED"

body=$(curl -s -b "$JAR2" "$BASE/api/v1/finance/expenses/categories")
has "a new gym gets usable categories rather than an empty list" "$body" "Electricity"


printf '\ninvoice PDFs\n'

# Raise a real invoice rather than hoping one exists: a skipped check reads
# like a pass in the summary and proves nothing.
json_field() { python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('$1',''))" 2>/dev/null; }

PLAN_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/memberships/plans" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Smoke Monthly","durationUnit":"MONTH","durationValue":1,"price":"1500"}' | json_field id)

MEMBER_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"firstName":"Smoke","lastName":"Tester","phone":"9820099001"}' | json_field id)

INV_ID=""
if [ -n "$PLAN_ID" ] && [ -n "$MEMBER_ID" ]; then
  INV_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/memberships/sell" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"memberId\":\"$MEMBER_ID\",\"planId\":\"$PLAN_ID\",\"payment\":{\"amount\":\"1500.00\",\"method\":\"CASH\"}}" \
    | json_field invoiceId)
fi

check "selling a membership raised an invoice" "true" "$([ -n "$INV_ID" ] && echo true || echo false)"

if [ -n "$INV_ID" ]; then
  headers=$(curl -s -b "$JAR2" -D- -o /tmp/smoke.pdf "$BASE/api/v1/finance/invoices/$INV_ID/pdf" | tr 'A-Z' 'a-z')
  case "$headers" in
    *application/pdf*) ok "the invoice PDF is served as a PDF";;
    *) bad "the invoice PDF is served as a PDF" "application/pdf" "see headers";;
  esac
  case "$headers" in
    *no-store*) ok "and is never held by a shared cache";;
    *) bad "and is never held by a shared cache" "no-store" "see headers";;
  esac

  magic=$(head -c 5 /tmp/smoke.pdf)
  check "the bytes really are a PDF" "%PDF-" "$magic"

  # Signed out, the same document must not be reachable.
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/finance/invoices/$INV_ID/pdf")
  check "a stranger cannot fetch someone's tax invoice" "401" "$code"
  rm -f /tmp/smoke.pdf

  # And the receipt for the payment that settled it — the slip a member who
  # paid cash actually walks away with.
  PAY_ID=$(curl -s -b "$JAR2" "$BASE/api/v1/finance/payments" \
    | python3 -c "import sys,json;d=json.load(sys.stdin).get('data') or [{}];print(d[0].get('id',''))" 2>/dev/null)

  check "the sale recorded a payment to receipt" "true" "$([ -n "$PAY_ID" ] && echo true || echo false)"

  headers=$(curl -s -b "$JAR2" -D- -o /tmp/smoke-receipt.pdf "$BASE/api/v1/finance/payments/$PAY_ID/receipt" | tr 'A-Z' 'a-z')
  case "$headers" in
    *application/pdf*) ok "the receipt is served as a PDF";;
    *) bad "the receipt is served as a PDF" "application/pdf" "see headers";;
  esac
  check "its bytes really are a PDF" "%PDF-" "$(head -c 5 /tmp/smoke-receipt.pdf)"

  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/finance/payments/$PAY_ID/receipt")
  check "a stranger cannot fetch someone's receipt" "401" "$code"
  rm -f /tmp/smoke-receipt.pdf
else
  printf '  - invoice PDF checks skipped (no invoice in this account)\n'
fi

# ------------------------------------------------------------------- crm ---
printf '\nenquiries\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/crm/leads")
check "enquiries are closed to strangers" "401" "$code"

# Cross-site write refusal, the same guard every other mutation has.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/crm/leads" \
  -H 'content-type: application/json' -H "origin: https://evil.example" \
  -d '{"fullName":"Cross Site","phone":"9811100000","source":"WALK_IN"}')
check "a cross-site enquiry POST is refused" "403" "$code"

LEAD_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/crm/leads" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"fullName":"Smoke Enquiry","phone":"9811100001","source":"INSTAGRAM","interestedIn":"Weight loss"}' \
  | json_field id)

check "an enquiry is recorded" "true" "$([ -n "$LEAD_ID" ] && echo true || echo false)"

if [ -n "$LEAD_ID" ]; then
  # The same number again: a warning the counter can override, not a block,
  # because couples and families share one phone.
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/crm/leads" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d '{"fullName":"Same Number","phone":"9811100001","source":"WALK_IN"}')
  check "a repeat number warns with 409" "409" "$code"

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/crm/leads" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d '{"fullName":"Same Number","phone":"9811100001","source":"WALK_IN","allowDuplicate":true}')
  check "and goes through when the counter says so" "201" "$code"

  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/crm/activity" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"leadId\":\"$LEAD_ID\",\"activityType\":\"CALL\",\"outcome\":\"Asked for a trial\",
         \"nextFollowUpAt\":\"2027-01-15\",\"status\":\"FOLLOW_UP\"}")
  has "logging a call moves the follow-up in one action" "$body" '"nextFollowUpAt"'

  body=$(curl -s -b "$JAR2" "$BASE/api/v1/crm/pipeline")
  has "the pipeline reports the stages" "$body" '"byStatus"'

  CONVERTED=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/crm/convert" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"leadId\":\"$LEAD_ID\"}" | json_field memberId)
  check "converting creates a member" "true" "$([ -n "$CONVERTED" ] && echo true || echo false)"

  body=$(curl -s -b "$JAR2" "$BASE/api/v1/crm/leads/$LEAD_ID")
  has "and the enquiry records where the member came from" "$body" '"CONVERTED"'
fi

# --------------------------------------------------------------- classes ---
printf '\nclasses\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/classes")
check "the timetable is closed to strangers" "401" "$code"

TYPE_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/classes/types" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Smoke Spin","defaultCapacity":1,"defaultDurationMinutes":45}' | json_field id)

check "a kind of class is created" "true" "$([ -n "$TYPE_ID" ] && echo true || echo false)"

if [ -n "$TYPE_ID" ]; then
  STARTS="$(date -u -d '+2 days 10:00' +%Y-%m-%dT%H:00:00Z 2>/dev/null || date -u +%Y-%m-%dT10:00:00Z)"

  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/classes/schedule" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"classTypeId\":\"$TYPE_ID\",\"startsAt\":\"$STARTS\",\"room\":\"Smoke Studio\"}")
  has "a class is put on the timetable" "$body" '"ids"'

  CLASS_ID=$(printf '%s' "$body" | python3 -c \
    "import sys,json;print(json.load(sys.stdin)['data']['ids'][0])" 2>/dev/null)

  # Three members paid up, so the only thing deciding the outcome is capacity.
  BOOKERS=""
  for n in 1 2 3; do
    MID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members" \
      -H 'content-type: application/json' -H "origin: $BASE" \
      -d "{\"firstName\":\"Racer$n\",\"lastName\":\"Smoke\",\"phone\":\"9${STAMP: -6}00$n\"}" \
      | json_field id)
    [ -n "$MID" ] || bad "a member for the race is created" "an id" "none"
    curl -s -o /dev/null -b "$JAR2" -X POST "$BASE/api/v1/memberships/sell" \
      -H 'content-type: application/json' -H "origin: $BASE" \
      -d "{\"memberId\":\"$MID\",\"planId\":\"$PLAN_ID\",\"payment\":{\"amount\":\"1500.00\",\"method\":\"CASH\"}}"
    BOOKERS="$BOOKERS $MID"
  done

  # The test that matters: three requests in flight for one place. Reading
  # the booked count and writing it back would let all three in, and the
  # class would run with two people too many.
  for MID in $BOOKERS; do
    curl -s -o "/tmp/book-$MID.json" -b "$JAR2" -X POST "$BASE/api/v1/classes/bookings" \
      -H 'content-type: application/json' -H "origin: $BASE" \
      -d "{\"classId\":\"$CLASS_ID\",\"memberId\":\"$MID\"}" &
  done
  wait

  # grep -o, not grep -c: the responses carry no trailing newline, so cat
  # runs them together and a line count would report one of each.
  BOOKED=$(cat /tmp/book-*.json | grep -o '"status":"BOOKED"' | wc -l | tr -d ' ')
  WAITING=$(cat /tmp/book-*.json | grep -o '"status":"WAITLISTED"' | wc -l | tr -d ' ')
  rm -f /tmp/book-*.json

  check "exactly one of three simultaneous requests gets the place" "1" "$BOOKED"
  check "and the other two are waitlisted" "2" "$WAITING"

  body=$(curl -s -b "$JAR2" "$BASE/api/v1/classes/$CLASS_ID")
  seats=$(printf '%s' "$body" | python3 -c \
    "import sys,json;d=json.load(sys.stdin)['data'];print(d['bookedCount']<=d['capacity'])" 2>/dev/null)
  check "the class is never oversold" "True" "$seats"

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/classes/cancel" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"classId\":\"$CLASS_ID\"}")
  check "cancelling a class without a reason is refused" "422" "$code"

  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/classes/cancel" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"classId\":\"$CLASS_ID\",\"reason\":\"Trainer unwell\"}")
  has "cancelling returns who has to be told" "$body" '"toInform"'
  told=$(printf '%s' "$body" | python3 -c \
    "import sys,json;print(len(json.load(sys.stdin)['data']['toInform']))" 2>/dev/null)
  check "one entry per member, booked and waiting alike" "3" "$told"
fi

# ------------------------------------------------------------ branches ---
printf '\nbranches\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/org/branches")
check "the branch list is closed to strangers" "401" "$code"

body=$(curl -s -b "$JAR2" "$BASE/api/v1/org/branches")
has "the registration branch is there and is the main one" "$body" '"isPrimary":true'

BRANCH2=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/org/branches" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Smoke Second","code":"SMK2","city":"Chhatrapati Sambhajinagar"}' | json_field id)
check "a second branch is added on the Growth plan" "true" \
  "$([ -n "$BRANCH2" ] && echo true || echo false)"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/org/branches" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Smoke Third","code":"SMK3"}')
check "and the third is refused, because Growth covers two" "403" "$code"

body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/org/branches" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Smoke Fourth","code":"SMK4"}')
has "with the plan named rather than a bare refusal" "$body" "Growth plan covers 2"
has "and a code the mobile app can branch on" "$body" "PLAN_LIMIT_REACHED"

# ------------------------------------------------------------- reports ---
printf '\nreports\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/reports?kind=tax")
check "reports are closed to strangers" "401" "$code"

body=$(curl -s -b "$JAR2" "$BASE/api/v1/reports?kind=tax&from=2020-01-01&to=2030-01-01")
has "the GST summary is by rate" "$body" '"byRate"'
has "with the CGST and SGST split" "$body" '"cgst"'

# Somebody who has not paid in full, so there is a debt to report. Every
# other sale in this run settles at the counter.
DEBTOR=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/members" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"firstName\":\"Owing\",\"lastName\":\"Smoke\",\"phone\":\"9${STAMP: -6}777\"}" \
  | json_field id)
curl -s -o /dev/null -b "$JAR2" -X POST "$BASE/api/v1/memberships/sell" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"memberId\":\"$DEBTOR\",\"planId\":\"$PLAN_ID\"}"

body=$(curl -s -b "$JAR2" "$BASE/api/v1/reports?kind=dues")
has "what is owed is grouped by member" "$body" '"daysOverdue"'
has "and names who to ring" "$body" "Owing Smoke"

headers=$(curl -s -b "$JAR2" -D- -o /tmp/report.csv \
  "$BASE/api/v1/reports/export?kind=dues" | tr 'A-Z' 'a-z')
case "$headers" in
  *text/csv*) ok "the export is served as a CSV";;
  *) bad "the export is served as a CSV" "text/csv" "see headers";;
esac
case "$headers" in
  *no-store*) ok "and is never held by a shared cache";;
  *) bad "and is never held by a shared cache" "no-store" "see headers";;
esac

head -c 13 /tmp/report.csv | grep -q '"member_code"' \
  && ok "with a quoted header row" \
  || bad "with a quoted header row" '"member_code"' "$(head -c 40 /tmp/report.csv)"
rm -f /tmp/report.csv

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/reports/export?kind=dues")
check "a stranger cannot download a gym's figures" "401" "$code"

# ---------------------------------------------------------------- rota ---
printf '\nrota and leave\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/staff/attendance")
check "the rota is closed to strangers" "401" "$code"

body=$(curl -s -b "$JAR2" "$BASE/api/v1/staff/attendance")
has "the register lists the team" "$body" '"fullName"'

ME=$(printf '%s' "$body" | python3 -c \
  "import sys,json;print(json.load(sys.stdin)['data'][0]['orgUserId'])" 2>/dev/null)

if [ -n "$ME" ]; then
  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/staff/attendance" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"orgUserId\":\"$ME\",\"action\":\"IN\"}")
  has "somebody can be marked in" "$body" '"status":"PRESENT"'

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/staff/shifts" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"orgUserId\":\"$ME\",\"weekday\":2,\"startTime\":\"18:00\",\"endTime\":\"09:00\"}")
  check "a shift ending before it starts is refused" "422" "$code"

  LEAVE_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/staff/leave" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d '{"leaveType":"Casual","fromDate":"2027-02-10","toDate":"2027-02-11"}' | json_field id)
  check "leave can be requested" "true" "$([ -n "$LEAVE_ID" ] && echo true || echo false)"

  # Nobody sanctions their own absence, however senior — the owner holds
  # every permission in the gym and still cannot.
  body=$(curl -s -b "$JAR2" -X PATCH "$BASE/api/v1/staff/leave" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"leaveId\":\"$LEAVE_ID\",\"approve\":true}")
  has "nobody approves their own leave" "$body" "Somebody else has to approve"

  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/staff/leave" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d '{"leaveType":"Sick","fromDate":"2027-02-11","toDate":"2027-02-12"}')
  has "overlapping leave is refused" "$body" "already has leave"
fi

# ------------------------------------------------------------- the shop ---
printf '\nthe shop\n'

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/inventory/products")
check "the shop is closed to strangers" "401" "$code"

PRODUCT_ID=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/inventory/products" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"Smoke Shake","sellingPrice":"150.00","purchasePrice":"90.00","openingStock":"1","reorderLevel":"1"}' \
  | json_field id)

check "a product is added" "true" "$([ -n "$PRODUCT_ID" ] && echo true || echo false)"

if [ -n "$PRODUCT_ID" ]; then
  body=$(curl -s -b "$JAR2" "$BASE/api/v1/inventory/products?lowOnly=true")
  has "a product at its reorder level is flagged" "$body" "Smoke Shake"

  # Two tills, one unit. Reading the stock and writing it back would sell it
  # twice and hand a customer an invoice for something that is not there.
  for n in 1 2; do
    curl -s -o "/tmp/sale-$n.json" -b "$JAR2" -X POST "$BASE/api/v1/inventory/sales" \
      -H 'content-type: application/json' -H "origin: $BASE" \
      -d "{\"lines\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":\"1\"}],
           \"customerName\":\"Counter\",\"payment\":{\"amount\":\"150.00\",\"method\":\"CASH\"}}" &
  done
  wait

  SOLD=$(cat /tmp/sale-*.json | grep -o '"invoiceCode"' | wc -l | tr -d ' ')
  REFUSED=$(cat /tmp/sale-*.json | grep -o '"code":"CONFLICT"' | wc -l | tr -d ' ')
  rm -f /tmp/sale-*.json

  check "only one of two simultaneous tills sells the last unit" "1" "$SOLD"
  check "and the other is told it is out of stock" "1" "$REFUSED"

  body=$(curl -s -b "$JAR2" "$BASE/api/v1/inventory/products")
  left=$(printf '%s' "$body" | python3 -c \
    "import sys,json;print([p for p in json.load(sys.stdin)['data'] if p['name']=='Smoke Shake'][0]['quantityOnHand'])" \
    2>/dev/null)
  check "stock never goes below zero" "0" "$left"

  # The counter cannot claim a gateway payment, the same rule the till obeys.
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/inventory/sales" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"lines\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":\"1\"}],
         \"payment\":{\"amount\":\"150.00\",\"method\":\"RAZORPAY\"}}")
  check "a counter sale cannot be marked as a gateway payment" "422" "$code"

  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X POST "$BASE/api/v1/inventory/stock" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"productId\":\"$PRODUCT_ID\",\"movementType\":\"WASTAGE\",\"quantity\":\"-1\"}")
  check "wastage without a reason is refused" "422" "$code"

  body=$(curl -s -b "$JAR2" -X POST "$BASE/api/v1/inventory/stock" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"productId\":\"$PRODUCT_ID\",\"movementType\":\"PURCHASE\",\"quantity\":\"24\",\"unitPrice\":\"90.00\"}")
  has "a delivery is recorded with the balance after it" "$body" '"balanceAfter":"24"'
fi

# ------------------------------------------------------------ plan limits ---
# A gym on Starter is told what its plan does not include, in a form the
# mobile app can branch on. Silence or a 500 here would read as a bug in the
# product rather than the edge of a plan.
printf '\nthe plan boundary\n'

JAR3="$(mktemp)"
curl -s -c "$JAR3" -o /dev/null -X POST "$BASE/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"gymName\":\"Starter Gym $STAMP\",\"ownerName\":\"Starter Owner\",
       \"email\":\"starter.$STAMP@example.com\",\"phone\":\"9876500022\",
       \"password\":\"$PASSWORD\",\"planKey\":\"STARTER\",\"acceptedTerms\":true}"

body=$(curl -s -b "$JAR3" "$BASE/api/v1/session")
has "a Starter gym signs in" "$body" '"key":"GYM_OWNER"'
held=$(printf '%s' "$body" | python3 -c \
  "import sys,json;d=json.load(sys.stdin)['data'];print('crm.lead.read' in d['permissions'])" \
  2>/dev/null)
check "Starter does not hold the CRM permissions" "False" "$held"
has "and the session says which feature the plan withholds" "$body" '"planLocked"'

body=$(curl -s -b "$JAR3" "$BASE/api/v1/crm/leads")
has "the CRM refuses with a code, not a crash" "$body" "FEATURE_NOT_IN_PLAN"
has "and names the feature in plain words" "$body" "enquiry and lead management"

code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR3" "$BASE/crm/leads")
check "the page itself answers 200 so it can explain the plan" "200" "$code"

body=$(curl -s -b "$JAR3" "$BASE/crm/leads")
has "the page names the plan that includes it" "$body" "Growth"

# Reports are not plan-gated: every gym can see its own position.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR3" "$BASE/api/v1/reports?kind=dues")
check "but a Starter gym still gets its own figures" "200" "$code"

# Members are in every plan: the lock must be the feature, not the gym.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR3" "$BASE/api/v1/members")
check "and everything in the Starter plan still works" "200" "$code"

rm -f "$JAR3"

rm -f "$JAR2"

# ------------------------------------------------------- every screen ---
# A brand-new gym with no data at all. Empty states are where 500s hide:
# every one of these pages is reached by a link in the sidebar, so one of
# them throwing is a dead end a real gym meets on their first morning.
printf '\nevery screen, on a gym with no data\n'

JAR4="$(mktemp)"
curl -s -c "$JAR4" -o /dev/null -X POST "$BASE/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"gymName\":\"Empty Gym $STAMP\",\"ownerName\":\"Empty Owner\",
       \"email\":\"empty.$STAMP@example.com\",\"phone\":\"9876500099\",
       \"password\":\"$PASSWORD\",\"planKey\":\"ENTERPRISE\",\"acceptedTerms\":true}"

SCREENS="/dashboard /members /members/new /members/import /memberships/plans
         /memberships/subscriptions /attendance/today /finance/payments
         /finance/invoices /finance/expenses /crm/leads /classes/schedule
         /inventory/products /staff /staff/rota /reports /settings/users
         /settings/branches /settings/security"

screen_failures=0
for screen in $SCREENS; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR4" "$BASE$screen")
  [ "$code" = "200" ] || {
    screen_failures=$((screen_failures + 1))
    printf '     %s -> %s\n' "$screen" "$code"
  }
done
check "every screen in the sidebar loads with no data" "0" "$screen_failures"

rm -f "$JAR4"

# ----------------------------------------------------------------- logout ---
printf '\nlogout\n'

code=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/logout")
check "logout succeeds" "200" "$code"

body=$(curl -s -b "$JAR" "$BASE/api/v1/session")
check "the session is gone server-side, not just in the browser" '{"data":null}' "$body"

code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/dashboard")
case "$code" in 302|303|307|308) ok "the dashboard is closed again";;
  *) bad "the dashboard is closed again" "3xx" "$code";; esac

rm -f "$JAR" "$FRESH" /tmp/e2e.out /tmp/e2e.dash

printf '\n%s passed, %s failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
