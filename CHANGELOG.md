# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.4.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/WJDdidi-1/cache-verdict/releases/tag/v0.1.0
