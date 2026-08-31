#!/usr/bin/env bash
# The definition of green. CI runs exactly this script after environment
# setup (.github/workflows/ci.yml installs node, deps, and a pinned pi,
# then calls it with no arguments), so one local run reproduces CI.
#
# Usage: scripts/verify.sh [gate...]
#   gates: typecheck unit smoke
#   No arguments runs all gates in CI order.
#
# No gate here ever touches the real claude or spends a token: the smoke
# drives real `pi` against tests/fake_claude.py. Paid characterization is
# deliberate, outside this script, with dated evidence in .local/.
set -euo pipefail
cd "$(dirname "$0")/.."

typecheck() {
  node_modules/.bin/tsc --noEmit
}

unit() {
  node --test tests/*.test.ts
}

smoke() {
  node tests/pi_smoke.mjs
}

if [ $# -eq 0 ]; then
  set -- typecheck unit smoke
fi
for gate in "$@"; do
  echo "== $gate"
  "$gate"
done
echo "verify: green"
