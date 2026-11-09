# cache-verdict

[![version](https://img.shields.io/badge/version-0.3.0-blue)](https://github.com/WJDdidi-1/cache-verdict/blob/main/CHANGELOG.md)

Times build-cache cold vs warm runs and says whether the cache pays.

## Who it is for

Maintainers of CI-heavy Rust, Gradle, Next.js, npm, Python, and Go repos whose caches report hits but builds remain slow, stale, or restore nothing.

## The problem

Teams add a cache, watch the hit counter, and still ship slow or stale builds: a warm build over a cache from another pipeline can be slower than a cold one (vercel/next.js#99579). A hit count says nothing about whether the cache is paying for itself, so nobody can decide whether to keep or drop it (wbskt/Wbskt#168).

## Why not the obvious answer

actions/cache, Swatinem/rust-cache, and gradle/actions/setup-gradle only store and restore artifacts and report hit/miss; sccache --show-stats counts compiler hits but ignores restore cost and the end-to-end build; hyperfine times commands but not cache states. None answers whether a given cache key is net-positive for this build.

## Releases

This tree is version **0.3.0**. Release tags follow `v<version>`, so its tag is
`v0.3.0`. The [CHANGELOG](https://github.com/WJDdidi-1/cache-verdict/blob/main/CHANGELOG.md)
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
npx cache-verdict@0.3.0 init
```

To install the current checkout before a release is on npm:

```sh
npm install -g .
cache-verdict --version
```

To install the exact tarball that CI verifies:

```sh
npm pack
npm install -g ./cache-verdict-0.3.0.tgz
```

The only files `cache-verdict` writes inside a project are `.cache-verdict.json` and the `.cache-verdict/` measurement directory.

## Quick start

```sh
# Detect the build system and write a reviewable config.
cache-verdict init

# Read command, inputs, and cachePath; edit anything that looks wrong.
cat .cache-verdict.json

# Take a cold sample, then a warm sample using the stored cache.
cache-verdict run
cache-verdict run

# See the numbers and one verdict.
cache-verdict report
```

`init` understands Cargo, Gradle, Next.js, npm (including pnpm, Yarn, and Bun lockfiles), Python, and Go. When several build systems match, pass `--ecosystem` to choose one. `init` never overwrites a reviewed config without `--force`.

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

`check` exits 0 for `cache-pays`, 2 for `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`, and 3 before there are enough samples to decide.

## What the MVP does

- `cache-verdict init` detects Cargo, Gradle, Next.js, npm, Python, or Go and writes a reviewable `.cache-verdict.json`.
- `cache-verdict run` content-addresses the declared inputs, moves declared cache dirs aside, restores the stored cache for that exact key when it exists, times the build from that known state, stores the produced artifacts, and appends one sample to `.cache-verdict/ledger.jsonl` (or the `--ledger` / `CACHE_VERDICT_LEDGER` path). The sample records the path and SHA-256 of each declared input, bounded so a huge input tree cannot bloat the ledger.
- `cache-verdict report` prints hit rate, median cold vs warm totals, restore cost, net ms per hit, cache size, the paths that changed since the previous sample, and one verdict: `cache-pays`, `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`.
- `cache-verdict check` exits 2 on a losing, churning, or unobserved cache and 3 when more runs are needed, so CI can gate on the verdict.
- `cache-verdict prune --keep N` evicts least-recently-used stored keys; `run --cold` adds a baseline sample without wedging the next hit.

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
  "detectedFrom": ["Cargo.toml"]
}
```

- `command` is the real build to time. It runs through the platform shell from the project directory.
- `inputs` are paths or globs. Their contents, the command, and the declared cache paths are hashed into the cache key. A key never silently reuses a cache measured for a different command. Each sample also records the path and SHA-256 of every matched input, so `report` can tell you which file changed the key.
- `cachePath` is what cache-verdict moves aside, restores, sizes, and stores. It may be a directory, a file, a glob such as `**/__pycache__`, or an environment-expanded path such as `$GOCACHE`. An empty list is reported as `cache-unobserved`.

## What the verdicts mean

| Verdict | Meaning |
| --- | --- |
| `cache-pays` | A warm hit is faster than the cold baseline, after paying the measured restore cost. |
| `cache-costs` | A warm hit is not faster than cold; the cache is not paying for itself. |
| `cache-churns` | More than one key appears in the samples, so the key changes too often to accumulate hits reliably. The report names the inputs that changed between the last two samples when they were recorded. |
| `cache-never-hits` | At least two samples were taken and none restored a stored cache. |
| `cache-unobserved` | There is no cache path, no ledger, only one cold sample, or no cold baseline yet. |

The report uses medians so one noisy sample does not decide the verdict. `Net ms per hit` is the median cold total minus the median warm total, where the warm total already includes restore time.

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

The explicit ledger path shipped in `cache-verdict@0.2.0` and remains in `0.3.0`. The two-build pattern was verified end to end with a scripted simulation; the [CI ledger validation record](docs/validation/ci-ledger-checkout.md) has the commands, output, and exit codes.

This GitHub Actions job treats exit 3 as "keep collecting" and gates as soon as the ledger has enough samples. It assumes a reviewed `.cache-verdict.json` is committed to the repository:

```yaml
name: cache-verdict gate
on: [push, pull_request]

jobs:
  gate:
    runs-on: ubuntu-latest
    env:
      CACHE_VERDICT_LEDGER: .ci/cache-verdict/ledger.jsonl
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # actions/cache entries are immutable. Restore the newest matching entry,
      # then save under a fresh key so this run's samples survive to the next.
      - uses: actions/cache/restore@v4
        with:
          path: |
            .ci/cache-verdict/ledger.jsonl
            .cache-verdict/store
          key: cache-verdict-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: |
            cache-verdict-${{ github.ref_name }}-

      - run: npm ci

      # The command appends one sample to CACHE_VERDICT_LEDGER.
      - run: npx --yes cache-verdict@0.3.0 run

      - name: Gate on the accumulated ledger
        run: |
          set +e
          npx --yes cache-verdict@0.3.0 check
          status=$?
          set -e
          if [ "$status" -eq 3 ]; then
            echo "::notice::cache-verdict needs another build before it can decide"
            exit 0
          fi
          exit "$status"

      # Save even when the gate exits 2, so a losing verdict is still recorded.
      - uses: actions/cache/save@v4
        if: always()
        with:
          path: |
            .ci/cache-verdict/ledger.jsonl
            .cache-verdict/store
          key: cache-verdict-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}
```

On the first build the ledger gets one cold sample and `check` exits 3, which the gate treats as "not enough samples yet". A later build with the same key restores the stored cache, records a warm sample, and `check` returns a real verdict. On a platform without a cache action, persist the same two paths with a volume, artifact, or object store.

If you want a hard gate immediately, build twice in one job instead:

```sh
cache-verdict run
cache-verdict run
cache-verdict check
```

`check` prints the same report as `report` and then:

- exits 0 for `cache-pays`,
- exits 2 for `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`,
- exits 3 when more samples are needed before a verdict is possible.

To add a fresh cold baseline in a pipeline without losing the stored cache that the next run should hit:

```sh
cache-verdict run --cold
```

## How we know it works

`npm test` runs 32 tests. CI runs the suite on Ubuntu, macOS, and Windows with Node.js 18, 20, and 22, then packs the tarball, installs it into a clean project, and runs the installed `cache-verdict` command. The published 0.1.0 tarball was also run end to end with `npx` on a fresh Next.js project outside this repository (numbers above and [validation record](docs/validation/nextjs-0.1.0.md)). The two-build shared-ledger CI pattern was verified with a scripted simulation of two fresh checkouts; its [validation record](docs/validation/ci-ledger-checkout.md) shows the first `check` exiting 3 and the second exiting 0 after the ledger and store were persisted. The changed-input explanation was verified with scripted two-run and cold/warm/edit probes; its [validation record](docs/validation/churn-explanation.md) shows the edited path in the text report, the `cache-churns` reason, and `report --json`, with the matching per-file hashes in the ledger. The end-to-end tests build throwaway projects and assert:

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

`--dry-run` prints the config to stdout and writes nothing.

### How many runs do I need before the verdict means anything?

One cold sample and one warm sample. The first `run` misses and stores the cache; the second restores that cache and hits. Until both exist, `check` exits 3 instead of inventing a verdict:

```sh
cache-verdict run && cache-verdict run && cache-verdict check
```

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

Early MVP, version 0.3.0. The features above are the scope; anything not listed is not built yet.

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 WJDdidi-1.
