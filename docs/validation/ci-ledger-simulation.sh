#!/usr/bin/env bash
# Reproduce the CI pattern from README.md: two builds in two fresh checkouts,
# sharing one ledger directory and a persisted cache store.
#
# Usage: docs/validation/ci-ledger-simulation.sh
#
# The first build records a cold sample and exits 3 from `check` (not enough
# samples). The second build starts from a clean checkout, restores the stored
# cache, records a warm sample in the same ledger, and `check` reaches a real
# verdict (0 or 2). No repository files are modified; everything happens in a
# temporary directory that is removed on exit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="$repo_root/bin/cache-verdict.mjs"
source_project="$repo_root/examples/npm-build-cache"

if [ ! -f "$cli" ]; then
  echo "missing CLI: $cli" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/cache-verdict-ci.XXXXXX")"
trap 'rm -rf "$work"' EXIT

shared="$work/shared"
mkdir -p "$shared"
export CACHE_VERDICT_LEDGER="$shared/ledger.jsonl"

# The project source that each CI run checks out. It must not contain
# measurement state from an earlier run.
cp -R "$source_project" "$work/source"
rm -rf \
  "$work/source/.cache-verdict" \
  "$work/source/.cache-verdict.json" \
  "$work/source/node_modules" \
  "$work/source/dist"

run_cli() {
  local directory="$1"
  shift
  (cd "$directory" && node "$cli" "$@")
}

echo "== Build 1: fresh checkout, one sample =="
cp -R "$work/source" "$work/build-1"
run_cli "$work/build-1" init
# In a real repository the reviewed config is committed; carry it into the
# second checkout below.
cp "$work/build-1/.cache-verdict.json" "$work/source/.cache-verdict.json"
run_cli "$work/build-1" run

# Persist the cache store alongside the ledger. The README's actions/cache
# steps restore and save both paths.
cp -R "$work/build-1/.cache-verdict/store" "$shared/store"

echo
echo "== Build 1 check: expected exit 3 =="
set +e
run_cli "$work/build-1" check
first_status=$?
set -e
echo "first check exit: $first_status"

echo
echo "== Build 2: fresh checkout, shared ledger and restored store =="
cp -R "$work/source" "$work/build-2"
mkdir -p "$work/build-2/.cache-verdict"
cp -R "$shared/store" "$work/build-2/.cache-verdict/store"
run_cli "$work/build-2" run

echo
echo "== Build 2 check: expected verdict (exit 0 or 2) =="
set +e
run_cli "$work/build-2" check
second_status=$?
set -e
echo "second check exit: $second_status"

echo
echo "== Shared ledger =="
cat "$shared/ledger.jsonl"

node -e '
const { readFileSync } = require("node:fs");
const rows = readFileSync(process.argv[1], "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
if (rows.length !== 2) {
  throw new Error(`expected 2 ledger rows, found ${rows.length}`);
}
if (rows[0].hit !== false || rows[0].cold !== true) {
  throw new Error("the first row is not a cold miss");
}
if (rows[1].hit !== true || rows[1].warm !== true) {
  throw new Error("the second row is not a warm hit");
}
if (rows[0].key !== rows[1].key) {
  throw new Error("the two builds used different keys");
}
' "$shared/ledger.jsonl"

echo
echo "first check exit: $first_status (expected 3)"
echo "second check exit: $second_status (expected 0 or 2)"
if [ "$first_status" -ne 3 ]; then
  echo "FAIL: the first check should still need more samples" >&2
  exit 1
fi
if [ "$second_status" -ne 0 ] && [ "$second_status" -ne 2 ]; then
  echo "FAIL: the second check should reach a verdict" >&2
  exit 1
fi
echo "PASS: the shared ledger carried the first sample into the second build."
