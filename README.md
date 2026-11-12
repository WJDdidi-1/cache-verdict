# cache-verdict

[![version](https://img.shields.io/badge/version-0.6.0-blue)](https://github.com/WJDdidi-1/cache-verdict/blob/main/CHANGELOG.md)

Times build-cache cold vs warm runs and says whether the cache pays.

## Who it is for

Maintainers of CI-heavy Rust, Gradle, Next.js, npm, Python, and Go repos whose caches report hits but builds remain slow, stale, or restore nothing.

## The problem

Teams add a cache, watch the hit counter, and still ship slow or stale builds: a warm build over a cache from another pipeline can be slower than a cold one (vercel/next.js#99579). A hit count says nothing about whether the cache is paying for itself, so nobody can decide whether to keep or drop it (wbskt/Wbskt#168).

## Why not the obvious answer

actions/cache, Swatinem/rust-cache, and gradle/actions/setup-gradle only store and restore artifacts and report hit/miss; sccache --show-stats counts compiler hits but ignores restore cost and the end-to-end build; hyperfine times commands but not cache states. None answers whether a given cache key is net-positive for this build.

## Releases

This tree is version **0.6.0**. Release tags follow `v<version>`, so its tag is
`v0.6.0`. The [CHANGELOG](https://github.com/WJDdidi-1/cache-verdict/blob/main/CHANGELOG.md)
describes what shipped in each version; the
[v0.1.0 release notes](https://github.com/WJDdidi-1/cache-verdict/blob/main/docs/releases/v0.1.0.md)
cover the first release.
[docs/RELEASING.md](https://github.com/WJDdidi-1/cache-verdict/blob/main/docs/RELEASING.md)
is the checklist for creating the tag, the GitHub release, and the npm publish.

## Install

```sh
npm install -g cache-verdict
cache-verdict --version
```

Requires Node.js 18 or newer. The package has no runtime dependencies.

Or run the published version without a global install:

```sh
npx cache-verdict@0.6.0 init
```

To install the current checkout before a release is on npm:

```sh
npm install -g .
cache-verdict --version
```

To install the exact tarball that CI verifies:

```sh
npm pack
npm install -g ./cache-verdict-0.6.0.tgz
```

The only files `cache-verdict` writes inside a project are `.cache-verdict.json` and the `.cache-verdict/` measurement directory, plus `.github/workflows/cache-verdict.yml` when `init --github-action` is used.

## Quick start

```sh
# Detect the build system and write a reviewable config.
cache-verdict init

# Or add the GitHub Actions workflow at the same time.
cache-verdict init --github-action

# Read command, inputs, and cachePath; edit anything that looks wrong.
cat .cache-verdict.json

# Optional: make check fail unless the cache saves enough. Add a policy
# object such as {"minNetMsPerHit": 50} to .cache-verdict.json.

# Take a cold sample, then a warm sample using the stored cache.
cache-verdict run
cache-verdict run

# See the numbers and one verdict.
cache-verdict report

# See every sample in order and whether the cache stopped hitting.
cache-verdict report --history

# Gate on the verdict and on the policy, if one is configured.
cache-verdict check
```

`init` understands Cargo, Gradle, Next.js, npm (including pnpm, Yarn, and Bun lockfiles), Python, and Go. When several build systems match, pass `--ecosystem` to choose one. `init` never overwrites a reviewed config or workflow without `--force`. Add `--github-action` to write `.github/workflows/cache-verdict.yml`, or combine it with `--dry-run` to preview both files first.

## Run the example

[`examples/npm-build-cache/`](examples/npm-build-cache/) is a tiny npm project with a deliberately slow cold build and a fast warm build. From a checkout:

```sh
npm run example
```

The runner copies the example to a temporary directory, then runs `init`, two `run` samples, and `report` with this checkout's CLI. The temporary copy is removed afterwards, so nothing is written into the repository. The first sample is a cold miss, the second restores the stored cache, and the report should say `cache-pays`.

To run the same flow by hand and inspect the config, ledger, and stored cache, see [the example README](examples/npm-build-cache/README.md).

## Measured on a project outside this repository

The published `cache-verdict@0.1.0` tarball was installed with `npx` into a fresh Next.js 15.5.29 App Router project outside this repository and run end to end. The project had a `next build` script, two routes, and no prior cache-verdict state; its declared cache path was Next.js's own `.next/cache`.

```console
$ npx --yes cache-verdict@0.1.0 init
Detected Next.js from package.json, next.config.mjs.
Wrote .cache-verdict.json.
Also detected: npm. Use --ecosystem to choose one instead.
note: Next.js stores build output in .next/cache; this path is measured.
Review "command", "inputs", and "cachePath" before sampling.

$ npx --yes cache-verdict@0.1.0 run
... Next.js build output omitted ...
cache-verdict: MISS (cold)
  key:     sha256:83b79b1063935dc084c2c3b2f2b018e2dac8848abfff92617679f044ba8e8bc6
  command: npm run build
  restore: 0.0 ms
  build:   7465.6 ms
  total:   7465.6 ms
  size:    46735665 bytes

$ npx --yes cache-verdict@0.1.0 run
... Next.js build output omitted ...
cache-verdict: HIT (warm)
  key:     sha256:83b79b1063935dc084c2c3b2f2b018e2dac8848abfff92617679f044ba8e8bc6
  command: npm run build
  restore: 14.6 ms
  build:   5053.9 ms
  total:   5068.5 ms
  size:    48814564 bytes

$ npx --yes cache-verdict@0.1.0 report
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 7465.6 ms
Median warm total: 5068.5 ms
Restore cost: 14.6 ms
Net ms per hit: 2397.1 ms
Cache size: 46.6 MiB across 1 stored key
Verdict: cache-pays
Reason: warm builds are 2397.1 ms faster per hit after paying the restore cost

$ npx --yes cache-verdict@0.1.0 check >/dev/null; echo $?
0
```

The warm run restored 46,735,665 bytes of cache in 14.6 ms and was 2397.1 ms faster end to end, so `check` exited 0. Those are two samples on one machine, not a benchmark; run the same commands on your project before deciding. The [validation record](docs/validation/nextjs-0.1.0.md) has the artifact hash, environment, exact config, ledger rows, and the paths this run did not cover.

`check` exits 0 for `cache-pays`, 2 for `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`, and 3 before there are enough samples to decide. With a savings policy it also exits 4 when the measured saving or restore cost misses a threshold; see [Savings policy](#savings-policy).

## What the MVP does

- `cache-verdict init` detects Cargo, Gradle, Next.js, npm, Python, or Go and writes a reviewable `.cache-verdict.json`; `init --github-action` also writes a GitHub Actions workflow that persists the ledger and stored cache.
- `cache-verdict run` content-addresses the declared inputs, moves declared cache dirs aside, restores the stored cache for that exact key when it exists, times the build from that known state, stores the produced artifacts, and appends one sample to `.cache-verdict/ledger.jsonl` (or the `--ledger` / `CACHE_VERDICT_LEDGER` path). The sample records the path and SHA-256 of each declared input, bounded so a huge input tree cannot bloat the ledger. `run --json` prints that sample instead of the text summary, with the build's output on stderr so stdout stays valid JSON.
- `cache-verdict report` prints hit rate, median cold vs warm totals, restore cost, net ms per hit, cache size, the paths that changed since the previous sample, and one verdict: `cache-pays`, `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`. `report --history` adds one row per sample and names the last hit when the history ends in misses; `report --json` always includes `history` and `regressedAt`.
- `cache-verdict check` exits 2 on a losing, churning, or unobserved cache and 3 when more runs are needed, so CI can gate on the verdict. It also enforces an optional savings policy and exits 4 when a configured minimum saving or maximum restore cost is missed.
- `cache-verdict prune --keep N` evicts least-recently-used stored keys; `prune --json` prints the kept and evicted keys. `run --cold` adds a baseline sample without wedging the next hit.
- Every `--json` payload starts with `"schemaVersion": 1`; see [JSON output contract](#json-output-contract).

## The config

`init` writes something like this; you can edit it by hand or regenerate it with `--force`:

```json
{
  "schemaVersion": 1,
  "ecosystem": "cargo",
  "displayName": "Cargo",
  "command": "cargo build",
  "inputs": ["Cargo.toml", "Cargo.lock", "src/**"],
  "cachePath": ["target"],
  "detectedFrom": ["Cargo.toml"],
  "policy": {
    "minNetMsPerHit": 50,
    "maxRestoreMs": 30
  }
}
```

`init` does not write a `policy` object; add one by hand when the project needs
to gate on savings rather than only on the verdict.

- `command` is the real build to time. It runs through the platform shell from the project directory.
- `inputs` are paths or globs. Their contents, the command, and the declared cache paths are hashed into the cache key. A key never silently reuses a cache measured for a different command. Each sample also records the path and SHA-256 of every matched input, so `report` can tell you which file changed the key.
- `cachePath` is what cache-verdict moves aside, restores, sizes, and stores. It may be a directory, a file, a glob such as `**/__pycache__`, or an environment-expanded path such as `$GOCACHE`. An empty list is reported as `cache-unobserved`.
- `policy` is optional. `minNetMsPerHit` fails `check` when the measured net saving per hit is below it; `maxRestoreMs` fails it when the median restore time is above it. Both must be non-negative numbers, and either may be omitted. See [Savings policy](#savings-policy).

## Savings policy

A `cache-pays` verdict only says the warm build is faster than cold. A team can
require more than that — for example, at least 50 ms saved per hit. Add a
top-level `policy` object to `.cache-verdict.json`:

```json
{
  "schemaVersion": 1,
  "ecosystem": "cargo",
  "displayName": "Cargo",
  "command": "cargo build",
  "inputs": ["Cargo.toml", "Cargo.lock", "src/**"],
  "cachePath": ["target"],
  "detectedFrom": ["Cargo.toml"],
  "policy": {
    "minNetMsPerHit": 50,
    "maxRestoreMs": 30
  }
}
```

Both thresholds are optional:

| Field | Fails `check` when |
| --- | --- |
| `minNetMsPerHit` | `Net ms per hit` is below the value. |
| `maxRestoreMs` | The median `Restore cost` is above the value. |

A missing or empty `policy` keeps the historical verdict-only behavior. A
threshold with no usable measurement is skipped, not treated as a pass or a
failure; `check` still exits 3 first when it needs more samples. Policy values
must be non-negative finite numbers, and a malformed policy is a config error
(exit 1), not a silent pass.

Override a threshold for one invocation with `--min-net-ms` or
`--max-restore-ms`:

```sh
cache-verdict check                              # config policy only
cache-verdict check --min-net-ms 50              # override the minimum saving
cache-verdict check --min-net-ms 75 --max-restore-ms 20
cache-verdict check --min-net-ms 50 --json       # policy and failures in JSON
```

Each flag replaces that one threshold for that run; the other config threshold
stays in effect. The override is not written back to `.cache-verdict.json`.

When a threshold is missed, `check` prints the measured value, the limit, and
the shortfall in the report and again on stderr, then exits 4. The verdict is
still reported, so a cache that pays but misses the team's bar is visible as
both `Verdict: cache-pays` and a policy failure:

```console
$ cache-verdict check
...
Net ms per hit: 30.4 ms
Policy: min net 50.0 ms per hit
Policy failure: policy.minNetMsPerHit missed: measured 30.4 ms saved per hit, needs at least 50.0 ms (shortfall 19.6 ms)
Verdict: cache-pays
Reason: warm builds are 30.4 ms faster per hit after paying the restore cost
cache-verdict: policy.minNetMsPerHit missed: measured 30.4 ms saved per hit, needs at least 50.0 ms (shortfall 19.6 ms)
```

`check --json` and `report --json` include `policy` (the effective thresholds,
with `null` for an unset one) and `policyFailures` (each failure's `threshold`,
`measured`, `limit`, `shortfall`, and `message`).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. `check` found `cache-pays` and every configured policy threshold passed. |
| 1 | No matching build system, unreadable directory, existing config or workflow, failed build command, or invalid config (including a malformed policy). |
| 2 | Invalid command-line usage, or `check` found `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`. |
| 3 | `check` needs more samples before it can decide; policy failures are not evaluated yet. |
| 4 | `check` missed a threshold in the configured savings policy (`--min-net-ms`, `--max-restore-ms`, or `policy`). |

The policy is checked from the same medians the report prints, after the
samples needed for a verdict exist. It does not override a losing verdict:
`cache-costs` still exits 2 unless a policy threshold also fails, in which case
the policy failure is reported and `check` exits 4.

### JSON output contract

Every `--json` payload starts with `"schemaVersion": 1` at the top level, so a
CI script can accept the versions it knows and fail closed on an unexpected
one:

| Command | Top-level payload |
| --- | --- |
| `report --json` | The analysis: `verdict`, `reason`, medians, cache size, `inputChanges`, `history`, `regressedAt`, `policy`, and `policyFailures`. |
| `check --json` | The same analysis as `report --json`, including the evaluated policy and failures. |
| `run --json` | The sample just appended to the ledger, including its key, timings, and recorded input hashes. |
| `prune --json` | `kept` and `evicted` arrays of stored cache keys. |

`schemaVersion` changes only when a field is removed, renamed, or given a new
meaning; adding a field is backwards compatible. Pin the version before
reading any other field:

```sh
cache-verdict report --json > report.json
node -e 'const r = require("./report.json"); if (r.schemaVersion !== 1) process.exit(1)'
```

`run --json` keeps stdout valid JSON by sending the build command's stdout and
stderr to stderr, so parse the CLI's stdout rather than the combined log.

## What the verdicts mean

| Verdict | Meaning |
| --- | --- |
| `cache-pays` | A warm hit is faster than the cold baseline, after paying the measured restore cost. |
| `cache-costs` | A warm hit is not faster than cold; the cache is not paying for itself. |
| `cache-churns` | More than one key appears in the samples, so the key changes too often to accumulate hits reliably. The report names the inputs that changed between the last two samples when they were recorded. |
| `cache-never-hits` | At least two samples were taken and none restored a stored cache. |
| `cache-unobserved` | There is no cache path, no ledger, only one cold sample, or no cold baseline yet. |

The report uses medians so one noisy sample does not decide the verdict. `Net ms per hit` is the median cold total minus the median warm total, where the warm total already includes restore time.

## Reading the sample history

The aggregate report can say `cache-pays` even when the cache stopped working: the medians still include the old hits. `report --history` prints the sequence the ledger already holds, so a cache that used to hit and then stopped is visible:

```console
$ cache-verdict report --history
Runs: 5 (1 hit, 4 misses)
Hit rate: 20.0%
Median cold total: 206.1 ms
Median warm total: 62.6 ms
Restore cost: 0.9 ms
Net ms per hit: 143.5 ms
Cache size: 17 B across 1 stored key
Changed inputs since previous sample: none
Verdict: cache-pays
Reason: warm builds are 143.5 ms faster per hit after paying the restore cost

History:
  #  Timestamp                 Result      Total        Net
   1  2026-11-11T17:32:36.788Z  MISS     206.7 ms    -0.6 ms
   2  2026-11-11T17:32:36.916Z  HIT       62.6 ms   143.5 ms
   3  2026-11-11T17:32:37.191Z  MISS     205.6 ms     0.5 ms
   4  2026-11-11T17:32:37.466Z  MISS     206.5 ms    -0.4 ms
   5  2026-11-11T17:32:37.741Z  MISS     205.6 ms     0.4 ms
Regression: sample 2 was the last hit; no sample has hit since.
```

Read the columns as follows:

- `#` is the sample's one-based position in the ledger, oldest first.
- `Timestamp` is when that sample was recorded.
- `Result` is `HIT` for a restored sample and `MISS` for a cold sample.
- `Total` is that sample's build plus restore time.
- `Net` is the median cold total minus that sample's total. Positive rows were faster than the median cold build; negative rows were slower.
- `Regression:` names the last hit before the trailing run of misses. Here samples 3-5 are all misses after the hit at sample 2, so the cache stopped being restored at sample 3. If the history never hit, never missed, or hit again after a run of misses, the report says there is no regression instead of guessing.

The aggregate `Verdict: cache-pays` and the `Regression:` line answer different questions: the verdict says the warm samples were cheaper on average, while the history says whether the cache is still producing them. Check the history before trusting an old verdict. `report --json` always includes the same sequence as `history` (each row has `index`, `timestamp`, `hit`, `totalMs`, and `netMs`) plus `regressedAt`, the one-based index of the last hit or `null` when there is no regression. The clean-install proof and the full fixture are in [the sample-history validation record](docs/validation/history.md).

## The ledger and stored cache

The default ledger is `.cache-verdict/ledger.jsonl`. `run`, `report`, and `check` accept `--ledger <path>` to read and append a different file, and `CACHE_VERDICT_LEDGER` supplies the same path when the flag is absent. An explicit flag wins over the environment variable. Relative paths resolve from the current working directory, and omitting both keeps the historical default, so existing projects need no changes. The ledger path only moves the ledger: stored artifacts stay under `.cache-verdict/store/`.

Each sample is one JSON object on its own line in the ledger:

```json
{
  "schemaVersion": 1,
  "key": "sha256:...",
  "hit": true,
  "cold": false,
  "warm": true,
  "buildMs": 1831.2,
  "restoreMs": 412.7,
  "totalMs": 2243.9,
  "sizeBytes": 104857600,
  "restoreSizeBytes": 104857600,
  "stored": true,
  "command": "cargo build",
  "inputs": [
    { "path": "Cargo.lock", "sha256": "..." },
    { "path": "Cargo.toml", "sha256": "..." },
    { "path": "src/main.rs", "sha256": "..." }
  ],
  "inputCount": 3,
  "inputsTruncated": false
}
```

`inputs` is the recorded path and SHA-256 of each declared input file, sorted by path. To keep an append-only ledger bounded, a sample records at most 500 files and roughly 48 KiB of input entries; when the matched input tree is larger, `inputsTruncated` is `true`, `inputCount` is the real number of hashed files, and the cache key still covers all of them.

`report` compares the last two samples and prints a `Changed inputs since previous sample:` line: `none`, the changed paths as `path (modified)`, `path (added)`, or `path (removed)`, or `unavailable` when one of the samples predates input recording. The same comparison is in `report --json` under `inputChanges` (`available`, `paths`, `changes` with before/after hashes, `truncated`, and the two sample keys). Old ledgers without `inputs` still produce a report; only the changed-input comparison is unavailable until the next sample is recorded. A [scripted probe](docs/validation/churn-explanation.md) shows the changed path in both the `cache-churns` reason and a two-run `cache-never-hits` reason.

Stored artifacts live under `.cache-verdict/store/<key>/`. Add `.cache-verdict/` to `.gitignore`; it is measurement state, not source. If a custom ledger lives inside the checkout, add that path too. Moving the declared cache dirs aside is what makes a cold sample genuinely cold. `prune` only removes stored keys, never ledger history.

## CI gating

By default every sample is appended to `.cache-verdict/ledger.jsonl`. That works for a job that builds twice, but a CI job that builds once per run starts from a fresh checkout and always sees a single sample, so `check` stays at exit 3. Put the ledger on a path that survives between builds with `--ledger <path>` or `CACHE_VERDICT_LEDGER`, and persist that path. Persist `.cache-verdict/store/` as well: the ledger decides the verdict, and the stored cache is what makes the next build a hit instead of another cold sample.

The explicit ledger path shipped in `cache-verdict@0.2.0` and remains in `0.6.0`. The two-build pattern was verified end to end with a scripted simulation; the [CI ledger validation record](docs/validation/ci-ledger-checkout.md) has the commands, output, and exit codes.

Generate the CI recipe instead of translating this section into YAML by hand:

```sh
cache-verdict init --github-action
```

With the flag, `init` also writes `.github/workflows/cache-verdict.yml`; without it, only `.cache-verdict.json` is written. If you already have a reviewed config, the flag keeps it and adds only the workflow; `--force` regenerates both. The workflow restores and saves `.ci/cache-verdict/ledger.jsonl` plus `.cache-verdict/store/` with `actions/cache`, runs `cache-verdict run`, then runs `cache-verdict check` and treats exit 3 as "keep collecting". It adds the detected package-manager install step and `setup-python` or `setup-go` when those ecosystems are detected; review the generated install and build steps before committing. `--dry-run --github-action` prints both files without writing, and `--force` replaces an existing workflow.

The [generated-recipe validation record](docs/validation/github-action-recipe.md) writes the workflow from a fixture, checks every required step and cache key, then runs the same `init`, two `run`s, and `check` locally with the workflow's ledger path. `npm test` repeats that sequence so the recipe is exercised rather than only described.

For a Cargo project the generated file is:

```yaml
# Generated by `cache-verdict init --github-action`.
# Review the install and build steps, then commit this file with
# .cache-verdict.json. The ledger lives at .ci/cache-verdict/ledger.jsonl so it
# survives between builds; the local default is .cache-verdict/ledger.jsonl.
name: cache-verdict gate

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  cache-verdict:
    runs-on: ubuntu-latest
    env:
      CACHE_VERDICT_LEDGER: .ci/cache-verdict/ledger.jsonl
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Restore the cache-verdict ledger and stored cache
        uses: actions/cache@v4
        with:
          path: |
            .ci/cache-verdict/ledger.jsonl
            .cache-verdict/store
          key: cache-verdict-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: |
            cache-verdict-${{ github.ref_name }}-

      - name: cache-verdict run
        run: npx --yes cache-verdict@0.6.0 run

      - name: cache-verdict check
        run: |
          set +e
          npx --yes cache-verdict@0.6.0 check
          status=$?
          set -e
          if [ "$status" -eq 3 ]; then
            echo "::notice::cache-verdict needs another build before it can decide"
            exit 0
          fi
          exit "$status"
```

On the first build the ledger gets one cold sample and `check` exits 3, which the gate treats as "not enough samples yet". A later build restores the newest matching cache entry, records a warm sample, and `check` returns a real verdict. The workflow saves under a run-specific key because `actions/cache` entries are immutable. On a platform without a cache action, persist the same two paths with a volume, artifact, or object store.

If you want a hard gate immediately, build twice in one job instead:

```sh
cache-verdict run
cache-verdict run
cache-verdict check
```

`check` prints the same report as `report` and then:

- exits 0 for `cache-pays` when every configured policy threshold passes,
- exits 2 for `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`,
- exits 3 when more samples are needed before a verdict is possible,
- exits 4 when a configured `--min-net-ms`, `--max-restore-ms`, or `policy` threshold is missed.

The generated workflow already propagates every non-zero `check` exit except 3,
so a policy failure fails the job without any extra YAML. Set the policy in
`.cache-verdict.json` and commit it with the workflow.

To add a fresh cold baseline in a pipeline without losing the stored cache that the next run should hit:

```sh
cache-verdict run --cold
```

## How we know it works

`npm test` runs the full suite. CI runs it on Ubuntu, macOS, and Windows with Node.js 18, 20, and 22, then packs the tarball, installs it into a clean project, and runs the installed `cache-verdict` command. The published 0.1.0 tarball was also run end to end with `npx` on a fresh Next.js project outside this repository (numbers above and [validation record](docs/validation/nextjs-0.1.0.md)). The two-build shared-ledger CI pattern was verified with a scripted simulation of two fresh checkouts; its [validation record](docs/validation/ci-ledger-checkout.md) shows the first `check` exiting 3 and the second exiting 0 after the ledger and store were persisted. The generated GitHub Actions workflow was verified by writing it from a fixture, asserting each step and cache key, and running the same ledger path and command sequence locally; the [recipe validation record](docs/validation/github-action-recipe.md) shows the generated file, both `check` exit codes, and the resulting ledger and store. The changed-input explanation was verified with scripted two-run and cold/warm/edit probes; its [validation record](docs/validation/churn-explanation.md) shows the edited path in the text report, the `cache-churns` reason, and `report --json`, with the matching per-file hashes in the ledger. The savings policy was verified through a clean `npm pack` + install: the installed CLI exits 4 with the measured value, limit, and shortfall for a strict policy, and exits 0 for a permissive policy or a `--min-net-ms` override; the [savings-policy validation record](docs/validation/savings-policy.md) has the tarball hash, commands, output, and exit codes. The sample history was verified the same way: a clean `npm pack` + install on a five-run fixture whose cache hit once and then stopped prints one row per sample, ends with `Regression: sample 2 was the last hit`, and returns `regressedAt: 2` from `report --json`; the [sample-history validation record](docs/validation/history.md) has the tarball hash, commands, rows, and JSON. The end-to-end tests build throwaway projects and assert:

- an identical key restores on the second run and reports `cache-pays` with exit 0;
- a slower warm build reports `cache-costs` with exit 2;
- changing inputs produce multiple keys, report `cache-churns`, and name the modified path in text and `--json`;
- unchanged inputs record identical hashes and report `Changed inputs since previous sample: none`;
- ledger samples written before input recording still report successfully, and the recorded input list is bounded;
- a cache that is never restored after two samples reports `cache-never-hits`;
- an empty `cachePath` reports `cache-unobserved`;
- `run --cold` records a baseline while still allowing the next normal run to hit;
- `prune --keep` evicts least-recently-used keys;
- `run` refuses a cachePath that would move the project itself;
- a custom `--ledger` path receives the samples that `run`, `report`, and `check` read, without writing the default ledger;
- `CACHE_VERDICT_LEDGER` works between builds and `--ledger` overrides it;
- `init --github-action` writes a workflow with `actions/cache`, package-manager install, a `cache-verdict run` step, a `cache-verdict check` step that accepts exit 3, and the persisted ledger path;
- the generated workflow is written from a fixture, every required step and cache key is asserted, and the same ledger path and command sequence run locally through one cold sample, `check` exit 3, one warm sample, and `check` exit 0 with `cache-pays`;
- `check` passes a configured policy, exits 4 with the threshold name, measured value, limit, and shortfall when `minNetMsPerHit` or `maxRestoreMs` is missed, and still returns the verdict-only 0, 2, and 3 codes when no policy is set;
- `--min-net-ms` and `--max-restore-ms` override the config policy per threshold, both flag forms work, and an invalid or malformed threshold is rejected;
- a clean `npm pack` + install exposes the policy flags, exits 4 with the shortfall for a strict policy, and exits 0 for a permissive policy and a command-line override;
- a clean `npm pack` + install prints one history row per sample, names the last hit when the history ends in misses, and returns the same `history` and `regressedAt` from `report --json`;
- `init` without the flag writes no workflow, `init --github-action` preserves an existing reviewed config, `--dry-run --github-action` writes neither file, and an existing workflow is only replaced with `--force`;
- `report --json` and the initial "not enough samples" check behave as documented.

The same flow by hand:

```sh
cache-verdict init && cache-verdict run && cache-verdict run && cache-verdict report
```

## FAQ

### Does cache-verdict run my build?

Yes. `run` executes the `command` from `.cache-verdict.json` through your platform shell in the project directory and times that process. Inspect the detected command, inputs, and cache paths before the first sample:

```sh
cache-verdict init --dry-run
```

`--dry-run` prints the config to stdout and writes nothing. Add `--github-action` to preview the workflow as well; it still writes neither file.

### How many runs do I need before the verdict means anything?

One cold sample and one warm sample. The first `run` misses and stores the cache; the second restores that cache and hits. Until both exist, `check` exits 3 instead of inventing a verdict:

```sh
cache-verdict run && cache-verdict run && cache-verdict check
```

### Can I require a minimum saving before CI passes?

Yes. Add a `policy` object to `.cache-verdict.json` and commit it with the
project:

```json
"policy": {
  "minNetMsPerHit": 50,
  "maxRestoreMs": 30
}
```

Then `check` exits 4 and prints the measured value, limit, and shortfall when
the saving is too small or the restore is too slow. To tighten or relax a
threshold for one job without editing the config, pass `--min-net-ms` or
`--max-restore-ms`:

```sh
cache-verdict check --min-net-ms 50
```

Both thresholds are optional. See [Savings policy](#savings-policy) for the
JSON fields and the full exit-code table.

### Why does my report say `cache-unobserved`?

There are four causes: `cachePath` is empty, no samples have been recorded, only one cold sample exists, or a warm sample arrived without a cold baseline. `report` prints the exact reason. Fix `cachePath` in `.cache-verdict.json` if it is empty, otherwise add the missing sample:

```sh
cache-verdict run --cold
```

### How do I know which file changed the cache key?

Run `cache-verdict report`; it compares the input hashes in the last two samples and prints the paths that changed, for example:

```console
Changed inputs since previous sample: src/input.txt (modified)
Verdict: cache-churns
Reason: 2 distinct keys across 3 samples; the cache key changes too often to accumulate hits; the last two samples changed src/input.txt (modified)
```

For machine-readable output, `cache-verdict report --json` puts the same comparison under `inputChanges`: `paths` lists the changed files and `changes` includes each path's before/after hash and whether it was `modified`, `added`, or `removed`. If the last two samples predate input recording, the comparison says so instead of guessing; one more `run` with this version records the hashes. The [churn explanation validation record](docs/validation/churn-explanation.md) shows a two-run probe with one edited input and a cold/warm/edit probe, with the commands, output, and matching ledger hashes.

### Does `run` replace or delete my real cache directory?

It moves each declared `cachePath` aside, restores a previously stored cache for the current key if one exists (a normal `run`, not `--cold`), then times the build and leaves the directory as that run produced it. The pre-run contents are put back only if the build fails. Review the declared paths first:

```sh
cat .cache-verdict.json
```

### Does it upload my numbers anywhere?

No. The CLI has no network code and records everything under `.cache-verdict/` in your project. To inspect the computed analysis directly:

```sh
cache-verdict report --json
```

### Can I change the build command or ecosystem?

Edit `command`, `inputs`, or `cachePath` in `.cache-verdict.json`, or regenerate the config with `--force`:

```sh
cache-verdict init --force --ecosystem npm --command "npm run build"
```

### How do I start over?

Remove the measurement directory. The reviewed config stays in place:

```sh
rm -rf .cache-verdict/
```

## Status

Early MVP, version 0.6.0. The features above are the scope; anything not listed
is not built yet.

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 WJDdidi-1.
