# Validation: a CI gate on a ledger that survives between builds

This verifies the CI pattern documented in [the README](../../README.md#ci-gating):
two builds in two fresh checkouts, one ledger directory shared between them,
and `check` reaching a real verdict on the second build instead of exiting 3.

The simulation is scripted in
[`ci-ledger-simulation.sh`](ci-ledger-simulation.sh). It uses only the Node.js
standard library and this checkout's CLI, writes everything to a temporary
directory, and removes that directory on exit.

## Artifact under test

- Source: this checkout at `f2af341` (the commit that added `--ledger` and
  `CACHE_VERDICT_LEDGER`), version `0.1.0`.
- CLI: `bin/cache-verdict.mjs` from that checkout.
- Project: a copy of [`examples/npm-build-cache/`](../../examples/npm-build-cache/),
  whose cold build spends 700 ms computing an artifact and whose warm build
  reuses it.

The published `cache-verdict@0.1.0` tarball predates the explicit ledger path,
so it cannot run this pattern yet. The commands below use the checkout (or a
tarball packed from it). A release containing the `--ledger` change is required
before the README's pinned `npx cache-verdict@0.1.0` snippet can be replaced
with a released version that supports it.

## Environment

- macOS, Darwin arm64
- Node.js v24.15.0
- npm 11.12.1
- Run on 2026-11-08

## Commands

From the repository root:

```sh
./docs/validation/ci-ledger-simulation.sh
npm test
```

The script models two CI runs. Each run gets a clean copy of the project, and
both runs point `CACHE_VERDICT_LEDGER` at the same shared ledger file. Inside
the script the commands below run as `node bin/cache-verdict.mjs <command>`
from the checkout, so no global install is needed:

```sh
export CACHE_VERDICT_LEDGER="$shared/ledger.jsonl"
```

Build 1:

```sh
cache-verdict init
cache-verdict run
cache-verdict check
```

The reviewed `.cache-verdict.json` is carried into the second checkout, as a
committed config would be. The produced `.cache-verdict/store/` is persisted
next to the ledger, as the README's `actions/cache` steps do.

Build 2 starts from a clean checkout, restores the persisted store, and runs:

```sh
cache-verdict run
cache-verdict check
```

## Output

Build 1 records a cold sample, then `check` exits 3 because there is only one
sample:

```console
== Build 1: fresh checkout, one sample ==
Detected npm from package.json.
Wrote .cache-verdict.json.
note: npm's download cache defaults to ~/.npm; set npm_config_cache=.npm in CI to keep it project-local and measurable.
Review "command", "inputs", and "cachePath" before sampling.

> cache-verdict-example-npm-build-cache@0.0.0 build
> node build.mjs

cold build: computing e0a2a3b5235f (this is the slow part)
wrote dist/result.txt
cache-verdict: MISS (cold)
  key:     sha256:107e67e9a947010c1d806e3ac403bc9dfc6ebd8446ebe60e612c76c0571910de
  command: npm run build
  restore: 0.0 ms
  build:   903.3 ms
  total:   903.3 ms
  size:    38 bytes

== Build 1 check: expected exit 3 ==
Runs: 1 (0 hits, 1 miss)
Hit rate: 0.0%
Median cold total: 903.3 ms
Median warm total: n/a
Restore cost: n/a
Net ms per hit: n/a
Cache size: 38 B across 1 stored key
Verdict: cache-unobserved
Reason: one cold sample is not enough; run again to collect a warm sample
cache-verdict: not enough samples yet in .../shared/ledger.jsonl; run the build again before gating CI
first check exit: 3
```

The temporary directory in the `check` stderr is shortened to `...` above; it
was a `mktemp` directory under the system temp area.

Build 2 is a fresh checkout with no `.cache-verdict/` state except the restored
store. It restores the same key, records a warm sample in the shared ledger,
and `check` exits 0:

```console
== Build 2: fresh checkout, shared ledger and restored store ==

> cache-verdict-example-npm-build-cache@0.0.0 build
> node build.mjs

warm build: reusing cached artifact e0a2a3b5235f
wrote dist/result.txt
cache-verdict: HIT (warm)
  key:     sha256:107e67e9a947010c1d806e3ac403bc9dfc6ebd8446ebe60e612c76c0571910de
  command: npm run build
  restore: 0.9 ms
  build:   178.5 ms
  total:   179.4 ms
  size:    38 bytes

== Build 2 check: expected verdict (exit 0 or 2) ==
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 903.3 ms
Median warm total: 179.4 ms
Restore cost: 0.9 ms
Net ms per hit: 723.9 ms
Cache size: 38 B across 1 stored key
Verdict: cache-pays
Reason: warm builds are 723.9 ms faster per hit after paying the restore cost
second check exit: 0

first check exit: 3 (expected 3)
second check exit: 0 (expected 0 or 2)
PASS: the shared ledger carried the first sample into the second build.
```

## Shared ledger

Both builds appended to the same file. Trimmed to the fields that decide the
verdict:

```json
{"key":"sha256:107e67e9a947010c1d806e3ac403bc9dfc6ebd8446ebe60e612c76c0571910de","hit":false,"cold":true,"buildMs":903.255,"restoreMs":0,"totalMs":903.255,"sizeBytes":38,"stored":true}
{"key":"sha256:107e67e9a947010c1d806e3ac403bc9dfc6ebd8446ebe60e612c76c0571910de","hit":true,"cold":false,"buildMs":178.464,"restoreMs":0.901,"totalMs":179.366,"sizeBytes":38,"restoreSizeBytes":38,"stored":true}
```

The key is identical across checkouts, the first row is the cold miss, and the
second row is the warm hit. Because the second sample is appended to the ledger
the first build created, `check` has two samples and can decide.

## What this proves

- A fresh checkout can append to a ledger outside its own tree through
  `CACHE_VERDICT_LEDGER`; the same path can be passed with `--ledger`, which
  `npm test` covers separately.
- A later build reads the earlier sample and reaches a verdict instead of
  exiting 3.
- Persisting both the ledger and `.cache-verdict/store/` is enough for the
  second build to hit; the store is still fixed under the project directory,
  so it has to be restored into the checkout.

## What this does not cover

- It does not call the GitHub Actions cache service. It verifies cache-verdict's
  path handling and verdict logic with a local shared directory; the action's
  restore/save behavior is GitHub's to test.
- It uses one small npm project. The timings are illustrative, not a benchmark,
  and other ecosystems are covered by `npm test`, not by this record.
- It does not verify the published 0.1.0 tarball, which predates the ledger
  option. The next release should rerun this simulation against the published
  artifact.
- Persisting only the ledger is not enough for a warm hit. Without the store,
  the second build is another cold sample and may report `cache-never-hits` or
  `cache-churns` rather than `cache-pays`; the README asks for both paths.
