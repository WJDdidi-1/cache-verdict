#!/usr/bin/env bash
# Reproduce the changed-input explanation end to end.
#
# Usage: docs/validation/churn-explanation.sh
#
# Two probes use the same tiny build, whose only measured input is
# src/input.txt:
#
# 1. A literal two-run probe: sample once, edit src/input.txt, sample again.
#    There is no hit, so the verdict is cache-never-hits, but the report must
#    still name the edited path and explain that the key changed with it.
# 2. The churn probe: sample cold, sample warm, edit src/input.txt, sample
#    again. The two keys and one hit produce cache-churns, and the report must
#    name the edited path in both the changed-input line and the reason.
#
# `report --json` must expose the same path with different before/after hashes
# in both cases. No repository files are modified; everything happens in a
# temporary directory that is removed on exit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli="$repo_root/bin/cache-verdict.mjs"

if [ ! -f "$cli" ]; then
  echo "missing CLI: $cli" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/cache-verdict-churn.XXXXXX")"
trap 'rm -rf "$work"' EXIT

make_project() {
  local project="$1"
  mkdir -p "$project/src"
  printf 'A\n' > "$project/src/input.txt"

  # A build that is slow when it has to compute and fast when the cache from the
  # same key is already in place. The artifact carries the input contents so a
  # stale cache cannot masquerade as a warm hit.
  cat > "$project/build.mjs" <<'EOF'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const input = readFileSync('src/input.txt', 'utf8').trim();
const cached =
  existsSync('cache/marker') && readFileSync('cache/marker', 'utf8').trim() === input;
const wait = cached ? 5 : 150;
const start = Date.now();
while (Date.now() - start < wait) {}

mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', `${input}\n`);
writeFileSync('cache/result.txt', `artifact for ${input}\n`);
console.log(cached ? 'warm build: reused the artifact' : 'cold build: computed the artifact');
EOF

  cat > "$project/.cache-verdict.json" <<'EOF'
{
  "schemaVersion": 1,
  "ecosystem": "npm",
  "displayName": "probe",
  "command": "node build.mjs",
  "inputs": ["src/input.txt", "build.mjs"],
  "cachePath": ["cache"],
  "detectedFrom": ["package.json"]
}
EOF
}

run_cli() {
  local project="$1"
  shift
  (cd "$project" && node "$cli" "$@")
}

# Assert the shared promise: the report names src/input.txt as modified, and
# --json carries the same path with different before/after hashes.
assert_changed_input() {
  local json="$1"
  local expected_verdict="$2"
  node -e '
const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
const expectedVerdict = process.argv[2];
if (report.verdict !== expectedVerdict) {
  throw new Error(`expected ${expectedVerdict}, got ${report.verdict}`);
}
if (!report.reason.includes("src/input.txt (modified)")) {
  throw new Error(`reason does not name the edited input: ${report.reason}`);
}
if (report.inputChanges.available !== true) {
  throw new Error("input changes are not available");
}
if (JSON.stringify(report.inputChanges.paths) !== JSON.stringify(["src/input.txt"])) {
  throw new Error(`expected only src/input.txt, got ${JSON.stringify(report.inputChanges.paths)}`);
}
const [change] = report.inputChanges.changes;
if (change.path !== "src/input.txt" || change.change !== "modified") {
  throw new Error(`unexpected change: ${JSON.stringify(change)}`);
}
if (!change.before || !change.after || change.before === change.after) {
  throw new Error("the before/after hashes are missing or identical");
}
' "$json" "$expected_verdict"
}

echo "== Probe 1: two runs with one edited input =="
two="$work/two-run"
make_project "$two"
run_cli "$two" run
echo
echo "Edit src/input.txt (A -> B), then take the second sample:"
printf 'B\n' > "$two/src/input.txt"
run_cli "$two" run

echo
echo "== Two-run report: no hit yet, but the changed path is named =="
two_report="$(run_cli "$two" report)"
printf '%s\n' "$two_report"
run_cli "$two" report --json > "$work/two-report.json"

case "$two_report" in
  *"Changed inputs since previous sample: src/input.txt (modified)"*) ;;
  *)
    echo "FAIL: two-run report did not name the changed path" >&2
    exit 1
    ;;
esac

case "$two_report" in
  *"Verdict: cache-never-hits"*) ;;
  *)
    echo "FAIL: two-run report should still say cache-never-hits" >&2
    exit 1
    ;;
esac

assert_changed_input "$work/two-report.json" cache-never-hits

echo
echo "== Probe 2: cold, warm, then the same edit =="
churn="$work/churn"
make_project "$churn"
run_cli "$churn" run
run_cli "$churn" run

echo
echo "Report before the edit:"
run_cli "$churn" report

echo
echo "Edit src/input.txt (A -> B), then take a third sample:"
printf 'B\n' > "$churn/src/input.txt"
run_cli "$churn" run

echo
echo "== Churn report: the key changed, so the cache churns =="
churn_report="$(run_cli "$churn" report)"
printf '%s\n' "$churn_report"
run_cli "$churn" report --json > "$work/churn-report.json"

echo
echo "== Changed inputs from report --json =="
node -e '
const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify(report.inputChanges, null, 2));
' "$work/churn-report.json"

echo
echo "== Churn ledger keys and the src/input.txt hash (trimmed) =="
node -e '
const { readFileSync } = require("node:fs");
const rows = readFileSync(process.argv[1], "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
for (const row of rows) {
  const input = row.inputs.find((entry) => entry.path === "src/input.txt");
  console.log(JSON.stringify({ key: row.key, hit: row.hit, input: input.sha256 }));
}
' "$churn/.cache-verdict/ledger.jsonl"

case "$churn_report" in
  *"Changed inputs since previous sample: src/input.txt (modified)"*) ;;
  *)
    echo "FAIL: churn report did not name the changed path" >&2
    exit 1
    ;;
esac

case "$churn_report" in
  *"Verdict: cache-churns"*) ;;
  *)
    echo "FAIL: churn report did not reach cache-churns" >&2
    exit 1
    ;;
esac

assert_changed_input "$work/churn-report.json" cache-churns

echo
echo "PASS: both reports named src/input.txt (modified), and the churn report explained the key change."
