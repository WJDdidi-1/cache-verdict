# cache-verdict

Times build-cache cold vs warm runs and says whether the cache pays

## Who it is for

Maintainers of CI-heavy Rust, Gradle, and Next.js repos whose caches report hits but builds remain slow, stale, or restore nothing.

## The problem

Teams add a cache, watch the hit counter, and still ship slow or stale builds: a warm build over a cache from another pipeline can be slower than a cold one (vercel/next.js#99579). A hit count says nothing about whether the cache is paying for itself, so nobody can decide whether to keep or drop it (wbskt/Wbskt#168).

## Why not the obvious answer

actions/cache, Swatinem/rust-cache, and gradle/actions/setup-gradle only store and restore artifacts and report hit/miss; sccache --show-stats counts compiler hits but ignores restore cost and the end-to-end build; hyperfine times commands but not cache states. None answers whether a given cache key is net-positive for this build.

## Install

```sh
npm install -g cache-verdict
```

## Use

```sh
cache-verdict --help
```

## What the MVP does

- cache-verdict init detects Cargo, Gradle, Next.js, npm, Python, or Go and writes a reviewable .cache-verdict.json.
- cache-verdict run content-addresses the declared inputs, moves declared cache dirs aside, times the build from a known state, and records key, hit/miss, cold/warm, size, and restore cost in a JSONL ledger.
- cache-verdict report prints hit rate, median cold vs warm totals, restore cost, net ms per hit, cache size, and one verdict: cache-pays, cache-costs, cache-churns, cache-never-hits, or cache-unobserved.
- cache-verdict check exits 2 on a losing, churning, or unobserved cache and 3 when more runs are needed, so CI can gate on the verdict.
- cache-verdict prune --keep N evicts least-recently-used stored keys; run --cold adds a baseline sample without wedging the next hit.

## How we know it works

cd cache-verdict && npm test - nine tests build throwaway repos and assert a faster warm cache reports cache-pays (exit 0), a slower one reports cache-costs (exit 2), a key that changes every run reports cache-never-hits, an empty cachePath reports cache-unobserved, and a --cold baseline still allows the next HIT. The same flow by hand: cache-verdict init && cache-verdict run && cache-verdict run 

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
