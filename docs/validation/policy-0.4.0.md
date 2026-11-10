# Validation: `check` has no savings policy (0.4.0)

`cache-verdict check` answers "does the cache pay at all?", not "does it save
enough?". In `cache-verdict@0.4.0` there is no threshold flag and no policy
field in `.cache-verdict.json`. A run that saves only 30.4 ms per hit still
gets `Verdict: cache-pays` and exit `0`, so a team that requires at least
50 ms per hit cannot gate CI on `check` alone.

This record captures the gap before the policy feature lands; it does not
change the CLI or the config schema.

> The policy has since been implemented in this tree. The clean-install
> verification and exit 4/0 behavior are recorded in
> [savings-policy.md](savings-policy.md), and the README documents the policy
> block and the full exit-code table.

## Artifact and environment

- CLI: published `cache-verdict@0.4.0` (`npx --yes cache-verdict@0.4.0`),
  tarball integrity
  `sha512-rYPT15JbL+/VSC/OSdYvRDLrxFg5/Nib6WCHrqnZzUJgFyh2Q+vHSUTOgwxo4fLeETinsLhdNwSdcBF0x4SV+A==`.
- OS: macOS, Darwin arm64.
- Node.js v24.15.0, npm 11.12.1.
- Run on 2026-11-10.

## `check --help` has no threshold

The command was:

```console
$ npx --yes cache-verdict@0.4.0 check --help
```

Its complete output (77 lines) is:

```console
cache-verdict: times build-cache cold vs warm runs and says whether the cache pays

Usage:
  cache-verdict init [directory] [options]
  cache-verdict run [directory] [--cold] [--ledger <path>]
  cache-verdict report [directory] [--json] [--ledger <path>]
  cache-verdict check [directory] [--ledger <path>]
  cache-verdict prune [directory] --keep <n>
  cache-verdict --help
  cache-verdict --version

Commands:
  init    Detect Cargo, Gradle, Next.js, npm, Python, or Go in a project and
          write a reviewable .cache-verdict.json beside its build files.
  run     Move declared cache dirs aside, restore a cache for the content-
          addressed key when one exists, time the build, store the produced
          artifacts, and append a sample to .cache-verdict/ledger.jsonl.
  report  Print hit rate, median cold and warm totals, restore cost, net ms
          per hit, cache size, and one verdict.
  check   Exit 0 for cache-pays, 2 for cache-costs, cache-churns,
          cache-never-hits, or cache-unobserved, and 3 when more runs are
          needed before a verdict is possible.
  prune   Evict least-recently-used stored cache keys.

Init options:
  -e, --ecosystem <id>  Use this detector when several build systems match.
                        One of: nextjs, cargo, gradle, go, python, npm
      --command <cmd>   Override the detected build command.
      --github-action   Also write .github/workflows/cache-verdict.yml: a workflow that restores
                        the ledger and stored cache with actions/cache, runs
                        cache-verdict run, and gates on cache-verdict check.
  -f, --force           Overwrite an existing .cache-verdict.json or workflow.
      --dry-run         Print the config (and generated workflow) to stdout
                        instead of writing either file.
  -h, --help            Show this help.

Run options:
      --cold            Force a cold baseline sample. A stored cache is kept
                        for the next normal run, so it does not prevent a hit.
  -h, --help            Show this help.

Report options:
      --json            Print the analysis as JSON.
  -h, --help            Show this help.

Ledger options (run, report, and check):
      --ledger <path>   Read or append samples at this file instead of
                        .cache-verdict/ledger.jsonl. Relative paths resolve
                        from the current directory. CACHE_VERDICT_LEDGER
                        provides the same path when the flag is absent.

Prune options:
  -k, --keep <n>        Number of most-recently-used stored keys to retain.
  -h, --help            Show this help.

The config records the detected build command, the files whose contents make
up the cache key, the cache paths to measure, and why the project was detected.
Review and edit it before sampling. Detection order is Next.js, Cargo, Gradle,
Go, Python, then npm; use --ecosystem to override.

Measured files live under .cache-verdict/ in the project: ledger.jsonl is the
append-only sample history and store/ holds one content-addressed cache per
key. Add .cache-verdict/ to .gitignore. To carry samples between CI builds, put
the ledger on a persisted path with --ledger or CACHE_VERDICT_LEDGER; keep
store/ too so later builds can still restore a cache for the same key.

init --github-action writes .github/workflows/cache-verdict.yml next to the
config. The workflow restores and saves the ledger plus store/ with
actions/cache, appends a sample with run, and gates with check.

Exit codes:
  0  success; check found that the cache pays
  1  no matching build system, unreadable directory, existing config or
     workflow, or a failed build command
  2  invalid command-line usage; check found a losing, churning, unobserved,
     or never-hitting cache
  3  check needs more runs before it can decide
```

The only `check` usage is `cache-verdict check [directory] [--ledger <path>]`.
There is no `--min-net-ms`, `--min-savings`, or similar option, and the help
text defines success as "the cache pays" with no minimum.

## A fresh config has no policy field

After `npx --yes cache-verdict@0.4.0 init .` in a small npm fixture, the
top-level keys of the newly written `.cache-verdict.json` were:

```text
schemaVersion
ecosystem
displayName
command
inputs
cachePath
detectedFrom
notes
```

The complete fresh file was:

```json
{
  "schemaVersion": 1,
  "ecosystem": "npm",
  "displayName": "npm",
  "command": "npm run build",
  "inputs": [
    "package.json",
    "*.js",
    "*.mjs",
    "*.cjs",
    "*.ts",
    "*.tsx",
    "*.jsx",
    "src/**",
    "lib/**",
    "bin/**",
    "scripts/**"
  ],
  "cachePath": [
    "node_modules/.cache"
  ],
  "detectedFrom": [
    "package.json"
  ],
  "notes": [
    "npm's download cache defaults to ~/.npm; set npm_config_cache=.npm in CI to keep it project-local and measurable."
  ]
}
```

There is no `policy`, `thresholds`, or `minNetMsPerHit` key. `check` reads the
ledger and the stored cache, but nothing in the project can tell it what
"saving enough" means.

## A cache that pays 30.4 ms per hit still exits 0

The fixture's build sleeps 250 ms on the cold path and 230 ms on the warm path,
then writes a small artifact under `node_modules/.cache/policy-probe/`. That
gives a real positive saving, but well under a 50 ms policy.

Two samples produced one cold miss and one warm hit:

```console
$ npx --yes cache-verdict@0.4.0 run .

> policy-probe@1.0.0 build
> node build.mjs

cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:be930bb738b883f4c68484ca872df1990919e6aaeb4f058ef705b339d520f34e
  command: npm run build
  restore: 0.0 ms
  build:   452.0 ms
  total:   452.0 ms
  size:    6 bytes

$ npx --yes cache-verdict@0.4.0 run .

> policy-probe@1.0.0 build
> node build.mjs

warm build: reused the artifact
cache-verdict: HIT (warm)
  key:     sha256:be930bb738b883f4c68484ca872df1990919e6aaeb4f058ef705b339d520f34e
  command: npm run build
  restore: 0.9 ms
  build:   420.7 ms
  total:   421.6 ms
  size:    6 bytes
```

`report` measured 30.4 ms of net saving per hit:

```console
$ npx --yes cache-verdict@0.4.0 report .
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 452.0 ms
Median warm total: 421.6 ms
Restore cost: 0.9 ms
Net ms per hit: 30.4 ms
Cache size: 6 B across 1 stored key
Changed inputs since previous sample: none
Verdict: cache-pays
Reason: warm builds are 30.4 ms faster per hit after paying the restore cost
```

`check` printed the same numbers, called the cache a winner, and exited `0`:

```console
$ npx --yes cache-verdict@0.4.0 check .
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 452.0 ms
Median warm total: 421.6 ms
Restore cost: 0.9 ms
Net ms per hit: 30.4 ms
Cache size: 6 B across 1 stored key
Changed inputs since previous sample: none
Verdict: cache-pays
Reason: warm builds are 30.4 ms faster per hit after paying the restore cost
$ echo $?
0
```

| Requirement | Team policy | Measured | `check` result |
| --- | --- | --- | --- |
| Minimum net saving per hit | 50 ms | 30.4 ms | `cache-pays`, exit `0` |

The exit code follows the verdict alone: any positive `netMsPerHit` is enough.
So a CI job that runs only `cache-verdict check` accepts a cache that misses
the team's 50 ms bar.

## What this means

- With 0.4.0, a team that needs a minimum saving has to read `report --json`
  and compare `netMsPerHit` outside `cache-verdict`; `check` cannot express or
  enforce that bar.
- The config has no place to record the bar either, so the rule cannot travel
  with the project or be reviewed alongside `command`, `inputs`, and
  `cachePath`.
- The next milestone did add the policy field and made `check` fail when the
  measured saving is below it. This record remains the "before" state that the
  change must not silently redefine: in 0.4.0 a positive-but-small saving was a
  passing `cache-pays` run.

## Reproduce

```sh
mkdir policy-probe && cd policy-probe
cat > package.json <<'EOF'
{
  "name": "policy-probe",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "node build.mjs"
  }
}
EOF
cat > build.mjs <<'EOF'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const artifactDirectory = 'node_modules/.cache/policy-probe';
const artifact = `${artifactDirectory}/artifact.txt`;

if (existsSync(artifact)) {
  await sleep(230);
  process.stdout.write('warm build: reused the artifact\n');
} else {
  await sleep(250);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(artifact, 'ready\n');
  process.stdout.write('cold build: computed the artifact\n');
}
EOF

npx --yes cache-verdict@0.4.0 init .
npx --yes cache-verdict@0.4.0 run .
npx --yes cache-verdict@0.4.0 run .
npx --yes cache-verdict@0.4.0 report .
npx --yes cache-verdict@0.4.0 check .; echo $?
```

The absolute timings depend on the machine; the point is the comparison. The
sleeps are chosen so the net saving stays positive but below 50 ms, just above
the restore cost and process noise. In the recorded run the net saving was
30.4 ms, the verdict was `cache-pays`, and `check` exited `0`.
