#!/usr/bin/env bash
# Verify the savings policy through a clean npm pack and install.
#
# Usage: docs/validation/savings-policy.sh
#
# Packs this checkout, installs the tarball into an empty project, then uses
# the installed `cache-verdict` command on a fixture that pays, but by less
# than the configured minimum. The strict policy must exit 4 with a shortfall;
# a permissive policy and the --min-net-ms override must exit 0.
#
# No repository files are modified and no network is needed: the tarball has
# no runtime dependencies. Everything happens in a temporary directory removed
# on exit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/cache-verdict-policy.XXXXXX")"
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
  "name": "cache-verdict-policy-clean-install",
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

step "check --help shows the policy flags and exit 4"
node "$cli" check --help | grep -E -- '--min-net-ms|--max-restore-ms|4  check missed'

step "fixture: a cache that pays, but not by the configured minimum"
cat > "$project/package.json" <<'EOF'
{
  "name": "policy-probe",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "node build.mjs"
  }
}
EOF
cat > "$project/build.mjs" <<'EOF'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const artifactDirectory = 'node_modules/.cache/policy-probe';
const artifact = `${artifactDirectory}/artifact.txt`;

if (existsSync(artifact)) {
  await sleep(100);
  process.stdout.write('warm build: reused the artifact\n');
} else {
  await sleep(300);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(artifact, 'ready\n');
  process.stdout.write('cold build: computed the artifact\n');
}
EOF

(cd "$project" && node "$cli" init .)

set_policy() {
  node -e '
const fs = require("node:fs");
const [configPath, minimum] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.policy = { minNetMsPerHit: Number(minimum) };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "$project/.cache-verdict.json" "$1"
}

set_policy 500

step "run 1: cold miss"
(cd "$project" && node "$cli" run .)

step "run 2: warm hit"
(cd "$project" && node "$cli" run .)

step "strict policy (min 500 ms per hit): expected exit 4 and a shortfall"
set +e
(cd "$project" && node "$cli" check .) > "$work/strict.out" 2> "$work/strict.err"
strict_status=$?
set -e
cat "$work/strict.out"
cat "$work/strict.err"
echo "strict check exit: $strict_status"
if [ "$strict_status" -ne 4 ]; then
  echo "FAIL: expected the strict policy to exit 4, got $strict_status" >&2
  exit 1
fi
if ! grep -q 'policy.minNetMsPerHit missed' "$work/strict.out" "$work/strict.err"; then
  echo "FAIL: the strict check did not name the missed policy threshold" >&2
  exit 1
fi
if ! grep -q 'shortfall' "$work/strict.out" "$work/strict.err"; then
  echo "FAIL: the strict check did not report the shortfall" >&2
  exit 1
fi

step "permissive policy (min 0 ms per hit): expected exit 0"
set_policy 0
set +e
(cd "$project" && node "$cli" check .) > "$work/permissive.out" 2> "$work/permissive.err"
permissive_status=$?
set -e
cat "$work/permissive.out"
cat "$work/permissive.err"
echo "permissive check exit: $permissive_status"
if [ "$permissive_status" -ne 0 ]; then
  echo "FAIL: expected the permissive policy to exit 0, got $permissive_status" >&2
  exit 1
fi

step "command-line override (--min-net-ms 0) beats a strict config"
set_policy 500
set +e
(cd "$project" && node "$cli" check . --min-net-ms 0) > "$work/override.out" 2> "$work/override.err"
override_status=$?
set -e
cat "$work/override.out"
cat "$work/override.err"
echo "override check exit: $override_status"
if [ "$override_status" -ne 0 ]; then
  echo "FAIL: expected --min-net-ms 0 to override the strict config, got $override_status" >&2
  exit 1
fi

echo
echo "PASS: a clean npm pack + install enforces the savings policy."
