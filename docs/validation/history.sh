#!/usr/bin/env bash
# Verify the sample history and regression point through a clean npm pack and
# install.
#
# Usage: docs/validation/history.sh
#
# Packs this checkout, installs the tarball into an empty project, then runs,
# reports, and gates on the installed `cache-verdict` command against a fixture
# whose cache hits once and then stops being restored. The installed report
# must print one row per sample and name the last hit as the regression point.
#
# No repository files are modified and no network is needed: the tarball has
# no runtime dependencies. Everything happens in a temporary directory removed
# on exit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/cache-verdict-history.XXXXXX")"
trap 'rm -rf "$work"' EXIT

step() {
  printf '\n== %s ==\n' "$1"
}

# Keep npm's cache and logs inside the temporary directory: a shared cache can
# be read-only, which would fail before npm looks at the tarball.
export npm_config_cache="$work/npm-cache"
export npm_config_logs_dir="$work/npm-logs"
export npm_config_update_notifier=false
mkdir -p "$npm_config_cache" "$npm_config_logs_dir"

pack="$work/pack"
install="$work/install"
project="$work/project"
mkdir -p "$pack" "$install" "$project"

step "npm pack"
(cd "$repo_root" && npm pack --pack-destination "$pack")
tarball="$(find "$pack" -maxdepth 1 -name 'cache-verdict-*.tgz' -print -quit)"
if [ -z "$tarball" ]; then
  echo "FAIL: npm pack wrote no tarball" >&2
  exit 1
fi
echo "tarball: $tarball"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$tarball"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$tarball"
fi

step "npm install in a clean project"
cat > "$install/package.json" <<'EOF'
{
  "name": "cache-verdict-history-clean-install",
  "version": "1.0.0",
  "private": true
}
EOF
(cd "$install" && npm install "$tarball" --no-audit --no-fund --ignore-scripts --loglevel=error)

cli="$install/node_modules/cache-verdict/bin/cache-verdict.mjs"
if [ ! -f "$cli" ]; then
  echo "FAIL: installed package has no bin/cache-verdict.mjs" >&2
  exit 1
fi
node "$cli" --version

step "report --help shows the history flag"
node "$cli" report --help | grep -E -- '--history|regression point|regressedAt'

step "fixture: one cold sample, one warm hit, then three misses"
mkdir -p "$project/src"
printf 'A\n' > "$project/src/input.txt"
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
  "displayName": "history-probe",
  "command": "node build.mjs",
  "inputs": ["src/input.txt", "build.mjs"],
  "cachePath": ["cache"],
  "detectedFrom": ["package.json"]
}
EOF

step "sample 1: cold miss (creates the stored cache)"
(cd "$project" && node "$cli" run .)

step "sample 2: warm hit"
(cd "$project" && node "$cli" run .)

step "samples 3-5: drop the stored cache before each run, so the cache stops hitting"
for _ in 1 2 3; do
  rm -rf "$project/.cache-verdict/store"
  (cd "$project" && node "$cli" run .)
done

step "report --history: one row per sample and the last hit"
(cd "$project" && node "$cli" report . --history) | tee "$work/history.out"

if ! grep -q '^History:$' "$work/history.out"; then
  echo "FAIL: report --history printed no History section" >&2
  exit 1
fi
if ! grep -qE '^ *2 +[^ ]+ +HIT ' "$work/history.out"; then
  echo "FAIL: sample 2 is not a HIT row" >&2
  exit 1
fi
if ! grep -qE '^ *[345] +[^ ]+ +MISS ' "$work/history.out"; then
  echo "FAIL: the trailing samples are not MISS rows" >&2
  exit 1
fi
if ! grep -q 'Regression: sample 2 was the last hit; no sample has hit since\.' "$work/history.out"; then
  echo "FAIL: the report did not name sample 2 as the regression point" >&2
  exit 1
fi

step "report --json: history and regressedAt"
(cd "$project" && node "$cli" report . --json) > "$work/report.json"
node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (report.regressedAt !== 2) {
  throw new Error(`expected regressedAt 2, got ${report.regressedAt}`);
}
if (!Array.isArray(report.history) || report.history.length !== 5) {
  throw new Error(`expected 5 history rows, got ${report.history?.length}`);
}
const hits = report.history.map((entry) => (entry.hit ? "HIT" : "MISS"));
if (hits.join(",") !== "MISS,HIT,MISS,MISS,MISS") {
  throw new Error(`unexpected sequence: ${hits.join(",")}`);
}
console.log(JSON.stringify({ history: report.history, regressedAt: report.regressedAt }, null, 2));
' "$work/report.json"

echo
echo "PASS: a clean npm pack + install prints the sample history and the regression point."
