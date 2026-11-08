# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/WJDdidi-1/cache-verdict/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/WJDdidi-1/cache-verdict/releases/tag/v0.1.0
