# Validation: `report` hides the sample history (0.5.0)

`cache-verdict` records every sample, with a timestamp, in the append-only
ledger. `report` then reduces that history to medians, a hit rate, changed
inputs between the last two samples, and one verdict. In `0.5.0` there is no
per-sample output and no flag that asks for it: `report --help` offers only
`--json`, and `report --json` has no `samples` or `history` key.

That means a cache that used to hit and then stopped is not localised. A
fixture whose first two samples are warm hits and whose next three are cold
misses still reports `Verdict: cache-pays`, and nothing in the text or JSON
names the second sample as the last hit or the sample where hitting stopped.

This record captures the gap before the history is printed; it does not change
the CLI, the ledger, or the report schema.

## Artifact and environment

- CLI: `bin/cache-verdict.mjs` from this checkout at `0d5e9a6`, version
  `0.5.0`.
- OS: macOS 27.2.1, Darwin arm64.
- Node.js v24.15.0, npm 11.12.1.
- Run on 2026-11-11.

## `report --help` has no history option

The relevant parts of the help output are:

```console
$ node bin/cache-verdict.mjs report --help
```

```console
  cache-verdict report [directory] [--json] [--ledger <path>]
```

```console
Report options:
      --json            Print the analysis as JSON.
  -h, --help            Show this help.
```

There is no `--samples`, `--history`, or `--last` option, and the command
description still promises only aggregates:

```text
report  Print hit rate, median cold and warm totals, restore cost, net ms
        per hit, cache size, and one verdict.
```

## Fixture

A tiny project whose declared inputs are `src/input.txt` and `build.mjs`, with
`cache` as the measured cache path. The build sleeps about 150 ms when it has
to compute the artifact and about 5 ms when it can reuse one. The artifact
contains the input contents, so a stale cache cannot pass as a hit:

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

A setup run seeds the stored cache. It is recorded to a throwaway ledger, so the
history under inspection starts with the cache already warm; `report` reads the
default ledger. The first two samples then hit, and the next three miss after
`.cache-verdict/store/` is removed before each run. This models the regression
this epic is about: the persisted cache stopped being restored (for example, a
CI cache was evicted or a cache backend went away) while the sample history
kept growing. The key and recorded inputs do not change.

From inside the fixture, with `cli` pointing at this checkout's
`bin/cache-verdict.mjs` and `work` pointing at a temporary directory:

```sh
node "$cli" run --ledger "$work/seed.jsonl"  # setup: cold miss, not in the report
node "$cli" run     # sample 1: warm hit
node "$cli" run     # sample 2: warm hit

rm -rf .cache-verdict/store
node "$cli" run     # sample 3: cold miss
rm -rf .cache-verdict/store
node "$cli" run     # sample 4: cold miss
rm -rf .cache-verdict/store
node "$cli" run     # sample 5: cold miss
```

The setup run and the five inspected samples were real runs. Their summaries,
with the key shortened, are:

```console
== setup (throwaway ledger) ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb89...
  command: node build.mjs
  restore: 0.0 ms
  build:   209.0 ms
  total:   209.0 ms
  size:    17 bytes
== sample 1 ==
warm build: reused the artifact
cache-verdict: HIT (warm)
  key:     sha256:65a42774beb89...
  command: node build.mjs
  restore: 0.9 ms
  build:   62.6 ms
  total:   63.5 ms
  size:    17 bytes
== sample 2 ==
warm build: reused the artifact
cache-verdict: HIT (warm)
  key:     sha256:65a42774beb89...
  command: node build.mjs
  restore: 0.9 ms
  build:   65.4 ms
  total:   66.3 ms
  size:    17 bytes
== sample 3 ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb89...
  command: node build.mjs
  restore: 0.0 ms
  build:   207.9 ms
  total:   207.9 ms
  size:    17 bytes
== sample 4 ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb89...
  command: node build.mjs
  restore: 0.0 ms
  build:   207.5 ms
  total:   207.5 ms
  size:    17 bytes
== sample 5 ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb89...
  command: node build.mjs
  restore: 0.0 ms
  build:   207.2 ms
  total:   207.2 ms
  size:    17 bytes
```

## The report after the regression

The text report is:

```console
$ node bin/cache-verdict.mjs report
Runs: 5 (2 hits, 3 misses)
Hit rate: 40.0%
Median cold total: 207.5 ms
Median warm total: 64.9 ms
Restore cost: 0.9 ms
Net ms per hit: 142.6 ms
Cache size: 17 B across 1 stored key
Changed inputs since previous sample: none
Verdict: cache-pays
Reason: warm builds are 142.6 ms faster per hit after paying the restore cost
```

The report says `cache-pays` even though the last three samples were misses. The
medians compare the two early hits with the three later misses, so the report
still concludes that warm builds save time, even though there has been no warm
build since sample 2. It also says `Changed inputs since previous sample: none`,
because the last two samples had identical inputs and keys. Neither line says
that the cache used to hit and then stopped.

## The JSON has aggregates, not samples

`report --json` returned these top-level keys:

```text
runs, hits, misses, hitRate, coldRuns, warmRuns, uniqueKeys, medianColdMs,
medianWarmMs, restoreMs, netMsPerHit, storedKeys, cacheSizeBytes, cachePaths,
cacheState, inputChanges, verdict, moreRunsNeeded, reason, policy,
policyFailures
```

There is no `samples`, `history`, `timeline`, or `lastHit` key. The only
timestamps in the object belong to `inputChanges`, and that object covers just
the last two samples:

```text
inputChanges: available, reason, previousKey, currentKey, previousTimestamp,
currentTimestamp, paths, changes, truncated
```

The relevant part of the JSON was:

```json
{
  "runs": 5,
  "hits": 2,
  "misses": 3,
  "hitRate": 0.4,
  "coldRuns": 3,
  "warmRuns": 2,
  "uniqueKeys": 1,
  "medianColdMs": 207.505,
  "medianWarmMs": 64.861,
  "restoreMs": 0.878,
  "netMsPerHit": 142.644,
  "cacheState": "populated",
  "inputChanges": {
    "available": true,
    "previousKey": "sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c",
    "currentKey": "sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c",
    "previousTimestamp": "2026-11-11T17:11:08.395Z",
    "currentTimestamp": "2026-11-11T17:11:08.670Z",
    "paths": [],
    "changes": [],
    "truncated": false
  },
  "verdict": "cache-pays",
  "reason": "warm builds are 142.6 ms faster per hit after paying the restore cost"
}
```

`inputChanges.previousTimestamp` and `currentTimestamp` are samples 4 and 5.
The last hit, sample 2, is at `2026-11-11T17:11:07.843Z`; that timestamp
appears nowhere in the text report or in the JSON shown above.

## The ledger does have the sequence

The same project's ledger contains all five inspected samples with their
timestamps, including the hit flag:

```console
$ node -e '
const { readFileSync } = require("node:fs");
const rows = readFileSync(process.argv[1], "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));
for (const [index, row] of rows.entries()) {
  console.log(JSON.stringify({
    sample: index + 1,
    timestamp: row.timestamp,
    hit: row.hit,
    forcedCold: row.forcedCold,
    key: `${row.key.slice(0, 20)}...`,
  }));
}
' .cache-verdict/ledger.jsonl
{"sample":1,"timestamp":"2026-11-11T17:11:07.711Z","hit":true,"forcedCold":false,"key":"sha256:65a42774beb89..."}
{"sample":2,"timestamp":"2026-11-11T17:11:07.843Z","hit":true,"forcedCold":false,"key":"sha256:65a42774beb89..."}
{"sample":3,"timestamp":"2026-11-11T17:11:08.119Z","hit":false,"forcedCold":false,"key":"sha256:65a42774beb89..."}
{"sample":4,"timestamp":"2026-11-11T17:11:08.395Z","hit":false,"forcedCold":false,"key":"sha256:65a42774beb89..."}
{"sample":5,"timestamp":"2026-11-11T17:11:08.670Z","hit":false,"forcedCold":false,"key":"sha256:65a42774beb89..."}
```

The transition is visible here, at sample 3, not in the report. A user who only
runs `report` cannot tell whether the three misses came before the two hits or
after them, and cannot name the sample where hitting stopped without opening
the ledger and reconstructing the order by hand.

## What this proves

- `report --help` in 0.5.0 exposes only `--json`; there is no way to ask for
  sample rows.
- A five-sample fixture whose first two samples are hits and whose last three
  are misses still ends in `Verdict: cache-pays`, driven by the medians of the
  old hits.
- Neither the text report nor the `report --json` keys contain a per-sample
  sequence or name the last hit; the only timestamps in the JSON are the last
  two samples used by `inputChanges`.
- The ledger already records everything needed to show the regression:
  timestamp, hit flag, key, inputs, and timings for every sample.

## What this does not cover

- The timings are from one machine. They show that the cold and warm paths ran,
  not how fast any real project's cache is.
- The setup run that seeds the stored cache is real, but it is recorded to a
  throwaway ledger; only the five hit-then-miss samples are in the report.
- The fixture drops `.cache-verdict/store/` to model a cache that stopped being
  restored. It does not reproduce a specific CI cache eviction or a remote
  cache outage.
- It uses one small Node.js build. Cargo, Gradle, Next.js, npm, Python, and Go
  detection are covered by `npm test`, not by this record.
- It records the 0.5.0 behavior; the per-sample history and the regression
  point are the next milestones of this epic.

## Reproduce

From the repository root:

```sh
repo="$PWD"
cli="$repo/bin/cache-verdict.mjs"
work="$(mktemp -d "${TMPDIR:-/tmp}/cache-verdict-history.XXXXXX")"
project="$work/project"
mkdir -p "$project/src"
printf 'A\n' > "$project/src/input.txt"

cat > "$project/build.mjs" <<'EOF'
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
EOF

cat > "$project/.cache-verdict.json" <<'EOF'
{
  "schemaVersion": 1,
  "ecosystem": "npm",
  "displayName": "history-probe",
  "command": "node build.mjs",
  "inputs": ["src/input.txt", "build.mjs"],
  "cachePath": ["cache"],
  "detectedFrom": ["package.json"]
}
EOF

cd "$project"
node "$cli" run --ledger "$work/seed.jsonl"
node "$cli" run
node "$cli" run
for _ in 1 2 3; do
  rm -rf .cache-verdict/store
  node "$cli" run
done
node "$cli" report
node "$cli" report --json
rm -rf "$work"
```

The absolute timings depend on the machine; the sequence, the hit count, and
the fact that the report stays `cache-pays` do not.
