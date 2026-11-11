#!/usr/bin/env bash
# Smoke test for the hub API. Assumes `npm run dev` is running.
# Logs in through /api/auth/dev, exercises progress, income, plan, items and raids,
# and fails on any non-200 response or any response body containing "error".
#
#   npm run smoke                      against http://localhost:8788
#   BASE=http://localhost:9000 npm run smoke
set -uo pipefail

BASE="${BASE:-http://localhost:8788}"
JAR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$BODY"' EXIT
FAILED=0
PASSED=0

check() { # check METHOD PATH [JSON]
  local method="$1" path="$2" data="${3:-}" code
  if [[ -n "$data" ]]; then
    code=$(curl -sS -o "$BODY" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" \
      -H 'content-type: application/json' --data "$data" "$BASE$path") || code=000
  else
    code=$(curl -sS -o "$BODY" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$method" "$BASE$path") || code=000
  fi
  if [[ "$code" != 200 ]]; then
    echo "FAIL $method $path -> HTTP $code: $(head -c 300 "$BODY")"; FAILED=$((FAILED + 1))
  elif grep -qi 'error' "$BODY"; then
    echo "FAIL $method $path -> body mentions error: $(head -c 300 "$BODY")"; FAILED=$((FAILED + 1))
  else
    echo "ok   $method $path"; PASSED=$((PASSED + 1))
  fi
}

# Pull a numeric "id" out of the last response without needing jq.
last_id() { grep -o '"id":[0-9]*' "$BODY" | head -1 | cut -d: -f2; }

if ! curl -sS -o /dev/null "$BASE/"; then
  echo "Cannot reach $BASE. Start the site first: npm run dev"; exit 1
fi

check GET  /api/auth/dev
check GET  /api/me
check GET  /api/progress
check GET  /data/board.json
check GET  /data/items.json
check GET  /img/items/meth_lab_1.webp
check PUT  /api/progress '{"item_id":"meth_lab_1","done":true}'
check PUT  /api/progress '{"item_id":"meth_lab_1","done":false}'
check GET  '/api/income?level=1'
check GET  '/api/income?level=5'
check GET  /api/plan
check POST /api/plan '{"title":"smoke test goal","item_id":"meth_lab_1"}'
PLAN_ID=$(last_id)
if [[ -n "$PLAN_ID" ]]; then
  check PATCH  "/api/plan/$PLAN_ID" '{"done":true}'
  check DELETE "/api/plan/$PLAN_ID"
fi
check GET  /api/items
check GET  /api/raids
check POST /api/raids '{"kind":"info","target":"smoke test, ignore"}'
RAID_ID=$(last_id)
[[ -n "$RAID_ID" ]] && check DELETE "/api/raids/$RAID_ID"

# Remove a member: a throwaway test member logs in, then the dev admin removes them.
curl -sS -o /dev/null -c "$JAR.2" "$BASE/api/auth/dev?as=Smoke%20Leaver"
check DELETE "/api/members/dev:smoke-leaver"
rm -f "$JAR.2"

echo
echo "$PASSED passed, $FAILED failed"
[[ "$FAILED" == 0 ]]
