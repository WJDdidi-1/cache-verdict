# cache-verdict

Times build-cache cold vs warm runs and says whether the cache pays.

## Who it is for

Maintainers of CI-heavy Rust, Gradle, Next.js, npm, Python, and Go repos whose caches report hits but builds remain slow, stale, or restore nothing.

## The problem

Teams add a cache, watch the hit counter, and still ship slow or stale builds: a warm build over a cache from another pipeline can be slower than a cold one (vercel/next.js#99579). A hit count says nothing about whether the cache is paying for itself, so nobody can decide whether to keep or drop it (wbskt/Wbskt#168).

## Why not the obvious answer

actions/cache, Swatinem/rust-cache, and gradle/actions/setup-gradle only store and restore artifacts and report hit/miss; sccache --show-stats counts compiler hits but ignores restore cost and the end-to-end build; hyperfine times commands but not cache states. None answers whether a given cache key is net-positive for this build.

## Install

```sh
npm install -g cache-verdict
```

Requires Node.js 18 or newer. The package has no runtime dependencies, and the only files it writes inside a project are `.cache-verdict.json` and the `.cache-verdict/` measurement directory.

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

## What the MVP does

- `cache-verdict init` detects Cargo, Gradle, Next.js, npm, Python, or Go and writes a reviewable `.cache-verdict.json`.
- `cache-verdict run` content-addresses the declared inputs, moves declared cache dirs aside, restores the stored cache for that exact key when it exists, times the build from that known state, stores the produced artifacts, and appends one sample to `.cache-verdict/ledger.jsonl`.
- `cache-verdict report` prints hit rate, median cold vs warm totals, restore cost, net ms per hit, cache size, and one verdict: `cache-pays`, `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`.
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
- `inputs` are paths or globs. Their contents, the command, and the declared cache paths are hashed into the cache key. A key never silently reuses a cache measured for a different command.
- `cachePath` is what cache-verdict moves aside, restores, sizes, and stores. It may be a directory, a file, a glob such as `**/__pycache__`, or an environment-expanded path such as `$GOCACHE`. An empty list is reported as `cache-unobserved`.

## What the verdicts mean

| Verdict | Meaning |
| --- | --- |
| `cache-pays` | A warm hit is faster than the cold baseline, after paying the measured restore cost. |
| `cache-costs` | A warm hit is not faster than cold; the cache is not paying for itself. |
| `cache-churns` | More than one key appears in the samples, so the key changes too often to accumulate hits reliably. |
| `cache-never-hits` | At least two samples were taken and none restored a stored cache. |
| `cache-unobserved` | There is no cache path, no ledger, only one cold sample, or no cold baseline yet. |

The report uses medians so one noisy sample does not decide the verdict. `Net ms per hit` is the median cold total minus the median warm total, where the warm total already includes restore time.

## The ledger and stored cache

Each sample is one JSON object on its own line in `.cache-verdict/ledger.jsonl`:

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
  "command": "cargo build"
}
```

Stored artifacts live under `.cache-verdict/store/<key>/`. Add `.cache-verdict/` to `.gitignore`; it is measurement state, not source. Moving the declared cache dirs aside is what makes a cold sample genuinely cold. `prune` only removes stored keys, never ledger history.

## CI gating

```sh
cache-verdict run
cache-verdict run
cache-verdict check
```

`check` prints the same report and then:

- exits 0 for `cache-pays`,
- exits 2 for `cache-costs`, `cache-churns`, `cache-never-hits`, or `cache-unobserved`,
- exits 3 when more samples are needed before a verdict is possible.

To add a fresh cold baseline in a pipeline without losing the stored cache that the next run should hit:

```sh
cache-verdict run --cold
```

## How we know it works

`npm test` runs 25 tests. The end-to-end tests build throwaway projects and assert:

- an identical key restores on the second run and reports `cache-pays` with exit 0;
- a slower warm build reports `cache-costs` with exit 2;
- changing inputs produce multiple keys and report `cache-churns`;
- a cache that is never restored after two samples reports `cache-never-hits`;
- an empty `cachePath` reports `cache-unobserved`;
- `run --cold` records a baseline while still allowing the next normal run to hit;
- `prune --keep` evicts least-recently-used keys;
- `run` refuses a cachePath that would move the project itself;
- `report --json` and the initial "not enough samples" check behave as documented.

The same flow by hand:

```sh
cache-verdict init && cache-verdict run && cache-verdict run && cache-verdict report
```

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
