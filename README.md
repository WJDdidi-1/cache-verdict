# cache-verdict

[![version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/WJDdidi-1/cache-verdict/blob/main/docs/releases/v0.1.0.md)

Times build-cache cold vs warm runs and says whether the cache pays.

## Who it is for

Maintainers of CI-heavy Rust, Gradle, Next.js, npm, Python, and Go repos whose caches report hits but builds remain slow, stale, or restore nothing.

## The problem

Teams add a cache, watch the hit counter, and still ship slow or stale builds: a warm build over a cache from another pipeline can be slower than a cold one (vercel/next.js#99579). A hit count says nothing about whether the cache is paying for itself, so nobody can decide whether to keep or drop it (wbskt/Wbskt#168).

## Why not the obvious answer

actions/cache, Swatinem/rust-cache, and gradle/actions/setup-gradle only store and restore artifacts and report hit/miss; sccache --show-stats counts compiler hits but ignores restore cost and the end-to-end build; hyperfine times commands but not cache states. None answers whether a given cache key is net-positive for this build.

## Releases

This tree is version **0.1.0**. Release tags follow `v<version>`, so its tag is
`v0.1.0`. The [v0.1.0 release notes](https://github.com/WJDdidi-1/cache-verdict/blob/main/docs/releases/v0.1.0.md)
describe what shipped and how it was verified;
[docs/RELEASING.md](https://github.com/WJDdidi-1/cache-verdict/blob/main/docs/RELEASING.md)
is the checklist for creating the tag, the GitHub release, and the npm publish.
Notes for every version live in
[docs/releases/](https://github.com/WJDdidi-1/cache-verdict/tree/main/docs/releases/).

## Install

```sh
npm install -g cache-verdict
cache-verdict --version
```

Requires Node.js 18 or newer. The package has no runtime dependencies.

To install the current checkout before a release is on npm:

```sh
npm install -g .
cache-verdict --version
```

To install the exact tarball that CI verifies:

```sh
npm pack
npm install -g ./cache-verdict-0.1.0.tgz
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

## A real session

Below is an actual run on a small npm demo project (macOS, Node 24): a `build` script in `package.json`, two files under `src/`, and a build that keeps a local cache under `node_modules/.cache`. Timings differ by machine; the verdict is computed from the medians in the ledger.

```console
$ cache-verdict init
Detected npm from package.json.
Wrote .cache-verdict.json.
note: npm's download cache defaults to ~/.npm; set npm_config_cache=.npm in CI to keep it project-local and measurable.
Review "command", "inputs", and "cachePath" before sampling.

$ cache-verdict run

> build
> node build.mjs

built from source
cache-verdict: MISS (cold)
  key:     sha256:7daa0feeabc43045ad5ee427775d0f9a302c6bc0b725cedc95b642283d102181
  command: npm run build
  restore: 0.0 ms
  build:   416.6 ms
  total:   416.6 ms
  size:    105 bytes

$ cache-verdict run

> build
> node build.mjs

built from cache
cache-verdict: HIT (warm)
  key:     sha256:7daa0feeabc43045ad5ee427775d0f9a302c6bc0b725cedc95b642283d102181
  command: npm run build
  restore: 0.8 ms
  build:   166.9 ms
  total:   167.7 ms
  size:    105 bytes

$ cache-verdict report
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 416.6 ms
Median warm total: 167.7 ms
Restore cost: 0.8 ms
Net ms per hit: 248.9 ms
Cache size: 105 B across 1 stored key
Verdict: cache-pays
Reason: warm builds are 248.9 ms faster per hit after paying the restore cost

$ cache-verdict check >/dev/null && echo "the cache pays"
the cache pays
```

The warm run restored the cached artifact in 0.8 ms and skipped the expensive part of the build, so a hit is worth about 249 ms here. `check` exits 0 in this state, 2 when the cache loses, and 3 before there are enough samples to decide.

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

`npm test` runs 25 tests. CI runs the suite on Ubuntu, macOS, and Windows with Node.js 18, 20, and 22, then packs the tarball, installs it into a clean project, and runs the installed `cache-verdict` command. The end-to-end tests build throwaway projects and assert:

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

Early MVP, version 0.1.0. The features above are the scope; anything not listed is not built yet.

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 WJDdidi-1.
