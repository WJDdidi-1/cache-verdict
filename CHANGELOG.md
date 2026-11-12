# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Every `--json` payload now starts with `"schemaVersion": 1` at the top
  level: `report`, `check`, `run`, and `prune`. A CI script can pin the
  contract and fail closed instead of treating a renamed or removed field as
  a silent success. The README documents each payload and the exit codes, and
  adding a field does not bump the version.
- `run --json` prints the sample just appended to the ledger. The build
  command's stdout and stderr go to stderr in this mode so the CLI's stdout
  stays parseable JSON.
- `prune --json` prints the kept and evicted stored cache keys.

## [0.6.0] - 2026-11-11

### Added

- `report --history` prints one row per ledger sample, oldest first, with the
  sample index, timestamp, hit/miss result, build plus restore total, and net
  milliseconds against the median cold total. It also names the last hit when
  the history ends in misses, so a cache that used to hit and then stopped is
  visible instead of hidden by the aggregate medians.
- `report --json` always includes the same sequence as `history` and
  `regressedAt`, the one-based index of the last hit, or `null` when the
  history never hit, never missed, or recovered after the misses. `--json`
  needs no extra flag.
- `report --help` documents `--history`, the row columns, the regression point,
  and `regressedAt`.

### Documentation

- Recorded that `report` in 0.5.0 hides the sample sequence: a five-sample
  fixture whose first two samples are hits and whose last three are misses
  still prints `Verdict: cache-pays`, and neither the text report nor
  `report --json` names the sample where hitting stopped. `report --help`
  offers only `--json`. The commands, output, JSON keys, and ledger rows are in
  [the history validation record](docs/validation/history-0.5.0.md).
- The README shows the `report --history` output verbatim, explains how to read
  each column and the regression line, and notes that `report --json` carries
  `history` and `regressedAt`.
- The sample history was verified through a clean `npm pack` + install: a
  five-run fixture whose cache hit once and then stopped prints the full row
  sequence and `Regression: sample 2 was the last hit`, while `report --json`
  returns `regressedAt: 2`. The commands, tarball hash, rows, and JSON are in
  [the sample-history validation record](docs/validation/history.md).
  `test/history-install.test.mjs` repeats the check deterministically against
  the packed artifact.

## [0.5.0] - 2026-11-10

### Added

- `check` enforces an optional savings policy from `.cache-verdict.json`:
  `policy.minNetMsPerHit` fails when the measured net saving per hit is below
  the value, and `policy.maxRestoreMs` fails when the median restore cost is
  above it. A missed threshold exits 4 and prints the measured value, the
  limit, and the shortfall; the verdict is still reported so a cache that pays
  but misses the team's bar is visible as both `cache-pays` and a policy
  failure. A config with no policy keeps the historical 0, 2, and 3
  verdict-only exit codes.
- `check --min-net-ms <ms>` and `check --max-restore-ms <ms>` override one
  config threshold for a single invocation without rewriting the config. Both
  accept the `--flag value` and `--flag=value` forms, and the remaining config
  threshold stays in effect.
- `check --json` and `report --json` expose the effective `policy` and the
  `policyFailures` list, including each failure's threshold, measured value,
  limit, and shortfall.

### Documentation

- The README documents the optional `policy` block, both command-line
  overrides, the JSON fields, and the full exit-code table including exit 4.
- The policy was verified from a clean `npm pack` + install: the installed CLI
  exits 4 with the shortfall for a strict policy, and exits 0 for a permissive
  policy and a `--min-net-ms` override. The commands, tarball hash, output, and
  exit codes are in [the savings-policy validation record](docs/validation/savings-policy.md);
  `test/policy-install.test.mjs` repeats the check deterministically against
  the packed artifact.
- Recorded that `check` had no savings policy in 0.4.0: `check --help` exposes
  no threshold flag, a freshly initialised `.cache-verdict.json` has no policy
  field, and a measured 30.4 ms net saving per hit still produces
  `cache-pays` and exit `0`. The [0.4.0 policy validation record](docs/validation/policy-0.4.0.md)
  contains the published help output, the fresh config keys, and the probe run.

## [0.4.0] - 2026-11-10

### Added

- `init --github-action` writes `.github/workflows/cache-verdict.yml` as well as
  the config, so CI adoption is one command instead of a hand-written recipe.
  The generated workflow restores and saves the ledger and stored cache with
  `actions/cache`, runs a sample, and gates on `check`, treating exit 3 as
  "keep collecting". It adds the detected package-manager install step and
  `setup-python` or `setup-go` when those ecosystems are detected.
- `init --github-action` keeps an existing reviewed config and adds only the
  workflow. `--dry-run --github-action` prints both files without writing
  either, and `--force` replaces an existing workflow or config.
- The generated recipe is verified end to end: a fixture assertion covers every
  required step and cache key, then the same `init`, two `run`s, and `check`
  sequence runs locally with the workflow's ledger path. The commands, output,
  and exit codes are recorded in `docs/validation/github-action-recipe.md`.

### Changed

- `init --help` and the README document the new flag, the files it writes, and
  how a reviewed config is preserved.

## [0.3.0] - 2026-11-09

### Added

- `run` records the path and SHA-256 of each declared input in every ledger
  sample as `inputs`, with `inputCount` and `inputsTruncated`. Recording is
  bounded to 500 files and roughly 48 KiB per sample so a large input tree
  cannot bloat the append-only ledger; the cache key still covers every file.
- `report` and `check` print the paths that changed between the last two
  samples, and `report --json` exposes the comparison as `inputChanges` with
  added/modified/removed status and before/after hashes. A `cache-churns`
  reason and a populated `cache-never-hits` reason now name the changed inputs
  instead of telling users to compare opaque keys by hand.
- Ledger samples written before input recording remain readable; the report
  labels the comparison unavailable instead of failing.
- The changed-input explanation is verified end to end by a scripted probe: a
  two-run probe with one edited input names the path under `cache-never-hits`,
  and a cold/warm/edit sequence names it under `cache-churns`. The commands,
  output, and matching ledger hashes are recorded in
  `docs/validation/churn-explanation.md`.

## [0.2.0] - 2026-11-08

### Added

- `run`, `report`, and `check` accept `--ledger <path>` to read and append
  samples somewhere other than `.cache-verdict/ledger.jsonl`, such as a path a
  CI job persists between builds. Relative paths resolve from the current
  working directory, and the new `CACHE_VERDICT_LEDGER` environment variable
  supplies the same path when the flag is absent. An explicit flag wins over
  the environment variable, and the default ledger path is unchanged.
- A custom ledger's parent directory is created on the first write.

### Changed

- `check` prints the specific reason for a losing verdict instead of a generic
  "the cache did not pay for itself" message.
- `report` explains a `cache-never-hits` verdict differently depending on
  whether the declared cache path stayed empty or a cache was written but never
  restored, and points at the config field or ledger row to inspect. The JSON
  output now includes `cachePaths` and `cacheState`.
- The README documents the two-build CI pattern for carrying a ledger and
  stored cache between builds.

## [0.1.0] - 2026-11-07

### Added

- `init` detection for Cargo, Gradle, Next.js, npm (including pnpm, Yarn, and
  Bun lockfiles), Python, and Go, writing a reviewable `.cache-verdict.json`.
- `run` content-addressing of declared inputs, moving declared cache paths
  aside, timing the build from a known state, and recording key, hit/miss,
  cold/warm, size, and restore cost in a JSONL ledger.
- `report` with hit rate, median cold vs warm totals, restore cost, net ms per
  hit, cache size, and one verdict: `cache-pays`, `cache-costs`,
  `cache-churns`, `cache-never-hits`, or `cache-unobserved`.
- `check` for CI gating with exit codes 0, 2, and 3.
- `prune --keep N` for least-recently-used stored key eviction and `run --cold`
  for a fresh baseline sample.

[0.6.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/WJDdidi-1/cache-verdict/releases/tag/v0.1.0
