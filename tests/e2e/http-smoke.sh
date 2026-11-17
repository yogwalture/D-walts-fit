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
       \"planKey\":\"STARTER\",\"acceptedTerms\":true}")

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
