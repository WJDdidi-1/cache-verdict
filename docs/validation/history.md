# Validation: sample history and regression point from a clean install

`cache-verdict report --history` now prints one row per ledger sample and names
the last hit when the history ends in misses. `report --json` always includes
the same `history` array and `regressedAt` index. This record proves the
behavior through a clean `npm pack` + install rather than through the source
checkout:

- the installed `report --help` lists `--history` and describes the regression
  point and the `regressedAt` JSON field;
- a five-sample fixture whose only hit is sample 2 prints `MISS`, `HIT`,
  `MISS`, `MISS`, `MISS` and ends with
  `Regression: sample 2 was the last hit; no sample has hit since.`;
- the installed `report --json` returns five history rows and `regressedAt: 2`;
- the same installed CLI still prints the aggregate report without the history
  section unless `--history` is passed.

The timings below are from one machine. The sequence, the number of rows, and
`regressedAt` do not depend on machine speed.

## Artifact and environment

- Packed from this checkout with `npm pack`; the tarball contains the merged
  history code in `bin/cache-verdict.mjs` and `lib/report.mjs`.
  `package.json` still says `0.5.0` because this change is unreleased.
- Tarball: `cache-verdict-0.5.0.tgz`, size 44.6 kB, 19 files.
- SHA-256:
  `a93b763fa39c34fee3b76ab3418bcbce21a5e39e1e60836375720afebb3966af`.
- npm shasum: `4c12f68c41c2d8bf766b39cad3b92ab908e9136f`.
- macOS, Darwin arm64; Node.js v24.15.0, npm 11.12.1.
- Recorded on 2026-11-11.
- No network was needed: the tarball has no runtime dependencies.

## Pack and install

```console
$ npm pack --pack-destination "$work/pack"
...
npm notice name: cache-verdict
npm notice version: 0.5.0
npm notice filename: cache-verdict-0.5.0.tgz
npm notice package size: 44.6 kB
npm notice unpacked size: 159.3 kB
npm notice total files: 19
cache-verdict-0.5.0.tgz

$ npm install "$work/pack/cache-verdict-0.5.0.tgz" --no-audit --no-fund --ignore-scripts
added 1 package in 120ms

$ node node_modules/cache-verdict/bin/cache-verdict.mjs --version
0.5.0
```

The installed `report --help` includes the new flag and the JSON field:

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs report --help
...
  cache-verdict report [directory] [--history] [--json] [--ledger <path>]
...
          per hit, cache size, and one verdict. --history adds one row per
          sample and the regression point.
...
      --history         Print one row per sample (index, timestamp, hit/miss,
                        total ms, net ms) and the regression point. Net ms is
                        the sample history and regressedAt.
```

## Fixture

A tiny project whose declared inputs are `src/input.txt` and `build.mjs`, with
`cache` as the measured cache path. The build sleeps about 150 ms when it has
to compute the artifact and about 5 ms when it can reuse one. The artifact
records the input contents, so a stale cache cannot pass as a hit:

```js
// build.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const input = readFileSync('src/input.txt', 'utf8').trim();
const cached =
  existsSync('cache/marker') && readFileSync('cache/marker', 'utf8').trim() === input;
const wait = cached ? 5 : 150;
const start = Date.now();
while (Date.now() - start < wait) {}

mkdirSync('cache', { recursive: true });
writeFileSync('cache/marker', `${input}\n`);
writeFileSync('cache/result.txt', `artifact for ${input}\n`);
console.log(cached ? 'warm build: reused the artifact' : 'cold build: computed the artifact');
```

`.cache-verdict.json`:

```json
{
  "schemaVersion": 1,
  "ecosystem": "npm",
  "displayName": "history-probe",
  "command": "node build.mjs",
  "inputs": ["src/input.txt", "build.mjs"],
  "cachePath": ["cache"],
  "detectedFrom": ["package.json"]
}
```

From inside the fixture, with `cli` pointing at the installed
`node_modules/cache-verdict/bin/cache-verdict.mjs`:

```sh
node "$cli" run .                 # sample 1: cold miss, creates the stored cache
node "$cli" run .                 # sample 2: warm hit
rm -rf .cache-verdict/store
node "$cli" run .                 # sample 3: cold miss
rm -rf .cache-verdict/store
node "$cli" run .                 # sample 4: cold miss
rm -rf .cache-verdict/store
node "$cli" run .                 # sample 5: cold miss
```

Dropping `.cache-verdict/store/` before each later run models a cache that
stopped being restored, for example a CI cache that was evicted or a backend
that went away. The key and the recorded inputs do not change, so the misses
are not explained by a new cache key.

The five real runs produced:

```console
== sample 1: cold miss (creates the stored cache) ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.0 ms
  build:   206.7 ms
  total:   206.7 ms
  size:    17 bytes

== sample 2: warm hit ==
warm build: reused the artifact
cache-verdict: HIT (warm)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.9 ms
  build:   61.7 ms
  total:   62.6 ms
  size:    17 bytes

== samples 3-5: drop the stored cache before each run ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.0 ms
  build:   205.6 ms
  total:   205.6 ms
  size:    17 bytes
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.0 ms
  build:   206.5 ms
  total:   206.5 ms
  size:    17 bytes
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.0 ms
  build:   205.6 ms
  total:   205.6 ms
  size:    17 bytes
```

## `report --history` names the regression

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs report . --history
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

The aggregate section still says `cache-pays`, because the medians include the
one warm build. The history section is what localises the problem: after sample
2 every run was a miss, so the cache stopped being restored. Reading the
columns:

- `#` is the sample's ledger index, oldest first.
- `Timestamp` is when the sample was recorded.
- `Result` is `HIT` for a restored sample and `MISS` for a cold sample.
- `Total` is that sample's build plus restore time.
- `Net` is the median cold total minus that sample's total. Positive rows were
  faster than the median cold build; negative rows were slower.
- `Regression:` names the last hit before the trailing run of misses. It is
  absent when the history never hit, never missed, or hit again after the run
  of misses, because none of those describes a cache that stopped working.

Without `--history`, the installed CLI prints the aggregate report only:

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs report .
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
```

## `report --json` carries the same history

`--json` needs no extra flag: the history and regression point are always in
the object. The relevant part of the installed output is:

```json
{
  "history": [
    {
      "index": 1,
      "timestamp": "2026-11-11T17:32:36.788Z",
      "hit": false,
      "totalMs": 206.669,
      "netMs": -0.612
    },
    {
      "index": 2,
      "timestamp": "2026-11-11T17:32:36.916Z",
      "hit": true,
      "totalMs": 62.558,
      "netMs": 143.499
    },
    {
      "index": 3,
      "timestamp": "2026-11-11T17:32:37.191Z",
      "hit": false,
      "totalMs": 205.601,
      "netMs": 0.456
    },
    {
      "index": 4,
      "timestamp": "2026-11-11T17:32:37.466Z",
      "hit": false,
      "totalMs": 206.486,
      "netMs": -0.429
    },
    {
      "index": 5,
      "timestamp": "2026-11-11T17:32:37.741Z",
      "hit": false,
      "totalMs": 205.628,
      "netMs": 0.429
    }
  ],
  "regressedAt": 2
}
```

`regressedAt` is the one-based index of the last hit, or `null` when no
regression is present. A CI job can gate on it without parsing the table.

## What this verifies and what it does not

Verified:

- the packed and installed CLI exposes `report --history` and the help text
  explains the columns, the regression point, and `regressedAt`;
- a cache that hit once and then stopped prints one row per sample, in ledger
  order, and names the last hit;
- `report --json` from the installed package returns the same sequence and
  `regressedAt`;
- the aggregate report is unchanged when `--history` is not passed.

Not covered here:

- GitHub's cache service, a full CI run, or restore performance across
  machines; [the generated-recipe validation](github-action-recipe.md) covers
  the workflow shape and local command sequence.
- Every ecosystem's `cachePath`; the history reads the samples every ecosystem
  already records.
- A regression caused by a changed cache key. That is reported separately by
  `report`'s changed-input line and by the `cache-churns` verdict; this record
  holds the key and inputs constant on purpose.

The deterministic counterpart in `npm test` is
`test/history-install.test.mjs`: it packs and installs the package, writes a
fixed cold/hit/miss ledger, and asserts the same three rows, the regression
line, and `regressedAt` against the installed artifact, without depending on
machine speed.

## Reproduce

From the repository root:

```sh
docs/validation/history.sh
```

The script creates its own temporary projects, uses a private npm cache, and
removes everything on exit. It prints the tarball hash, the installed version,
the relevant help lines, the five samples, `report --history`, and the history
portion of `report --json`.

For just the deterministic clean-install test:

```sh
node --test test/history-install.test.mjs
```
