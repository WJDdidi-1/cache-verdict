#!/usr/bin/env bash
# Reproduce the generated GitHub Actions recipe locally.
#
# Usage: docs/validation/github-action-recipe.sh
#
# Writes a fixture project, runs `init --github-action`, prints the generated
# workflow, then runs the same ledger path and command sequence the workflow
# uses: one run, check (exit 3 because only one sample exists), a second run,
# and check again. The ledger must land on the workflow's CACHE_VERDICT_LEDGER
# path, and the stored cache must live under .cache-verdict/store.
#
# This does not call the GitHub Actions cache service; it proves the commands,
# paths, and exit handling the generated file depends on. No repository files
# are modified; everything happens in a temporary directory removed on exit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="$repo_root/bin/cache-verdict.mjs"

if [ ! -f "$cli" ]; then
  echo "missing CLI: $cli" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/cache-verdict-github-action.XXXXXX")"
trap 'rm -rf "$work"' EXIT

project="$work/project"
mkdir -p "$project/src"
printf 'ci recipe input\n' > "$project/src/input.txt"

cat > "$project/package.json" <<'EOF'
{
  "name": "cache-verdict-github-action-fixture",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs"
  }
}
EOF

# A deliberately slow cold build and a fast warm build, measuring the same
# node_modules/.cache path that init detects for npm.
cat > "$project/build.mjs" <<'EOF'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const cache = 'node_modules/.cache';
const warm = existsSync(cache + '/marker');
if (!warm) {
  const until = Date.now() + 250;
  while (Date.now() < until) {
    // Stand-in for compilation.
  }
}
mkdirSync(cache, { recursive: true });
writeFileSync(cache + '/marker', 'artifact\n');
writeFileSync(cache + '/payload.bin', 'x'.repeat(2048));
console.log(warm ? 'warm build: reused the artifact' : 'cold build: computed the artifact');
EOF

run_cli() {
  local directory="$1"
  shift
  (cd "$directory" && node "$cli" "$@")
}

step() {
  printf '\n== %s ==\n' "$1"
}

step "init --github-action"
run_cli "$project" init --github-action

workflow="$project/.github/workflows/cache-verdict.yml"
step "generated workflow: .github/workflows/cache-verdict.yml"
cat "$workflow"

ledger="$(awk '/CACHE_VERDICT_LEDGER:/{print $2; exit}' "$workflow")"
if [ -z "$ledger" ]; then
  echo "FAIL: the workflow does not set CACHE_VERDICT_LEDGER" >&2
  exit 1
fi
echo
echo "ledger from the generated workflow: $ledger"
export CACHE_VERDICT_LEDGER="$ledger"

step "run 1: cold miss"
run_cli "$project" run

step "check after one sample: expected exit 3"
set +e
run_cli "$project" check
first_check=$?
set -e
echo "first check exit: $first_check"
if [ "$first_check" -ne 3 ]; then
  echo "FAIL: expected the first check to exit 3, got $first_check" >&2
  exit 1
fi

step "run 2: warm hit"
run_cli "$project" run

step "check after two samples: expected exit 0"
set +e
run_cli "$project" check
second_check=$?
set -e
echo "second check exit: $second_check"
if [ "$second_check" -ne 0 ]; then
  echo "FAIL: expected the second check to exit 0, got $second_check" >&2
  exit 1
fi

step "state written to the workflow paths"
node -e '
const fs = require("node:fs");
const path = require("node:path");
const [ledgerFile, storeDirectory, defaultLedger] = process.argv.slice(1);
const rows = fs
  .readFileSync(ledgerFile, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

if (rows.length !== 2) throw new Error(`expected 2 samples, got ${rows.length}`);
if (rows[0].key !== rows[1].key) throw new Error("the two samples have different keys");
if (!(rows[0].cold === true && rows[0].hit === false)) throw new Error("sample 1 is not a cold miss");
if (!(rows[1].warm === true && rows[1].hit === true)) throw new Error("sample 2 is not a warm hit");
if (fs.existsSync(defaultLedger)) throw new Error(`wrote the local default ledger ${defaultLedger}`);

const storedKey = rows[0].key.replace(/^sha256:/, "");
const stored = fs.readdirSync(storeDirectory);
if (!stored.includes(storedKey)) throw new Error(`store is missing ${storedKey}`);
console.log(`samples: ${rows.length} (one cold miss, one warm hit)`);
console.log(`ledger:  ${path.basename(path.dirname(ledgerFile))}/${path.basename(ledgerFile)}`);
console.log(`key:     ${rows[0].key}`);
console.log(`store:   ${stored.length} key(s) under .cache-verdict/store`);
' "$project/$ledger" "$project/.cache-verdict/store" "$project/.cache-verdict/ledger.jsonl"

echo
echo "PASS: the generated recipe gate ran with the workflow's ledger path."
