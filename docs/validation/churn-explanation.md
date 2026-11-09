# Validation: report names the input that changed the cache key

This verifies the changed-input explanation added to the Unreleased section of
the [CHANGELOG](../../CHANGELOG.md) and documented in
[the README](../../README.md#the-ledger-and-stored-cache). Before this change,
`cache-churns` only said how many distinct keys appeared and told the user to
compare opaque hashes in `.cache-verdict/ledger.jsonl` by hand. The ledger did
not store per-file hashes, so that comparison was impossible.

The probe is scripted in
[`churn-explanation.sh`](churn-explanation.sh). It uses only the Node.js
standard library and this checkout's CLI, writes everything to a temporary
directory, and removes that directory on exit.

## Artifact under test

- Source: this checkout at `c56dae8` (the commit that added input recording and
  the changed-input report), version `0.2.0`.
- CLI: `bin/cache-verdict.mjs` from that checkout.
- Build: a tiny project whose declared inputs are `src/input.txt` and
  `build.mjs`, with `cache` as the measured cache path. It computes for about
  150 ms on a cold cache and reuses the artifact on a warm one. The artifact
  contains the input contents, so a stale cache cannot pass as a hit.

## Environment

- macOS 27.2, arm64
- Node.js v24.15.0
- npm 11.12.1
- Run on 2026-11-09

## Commands

From the repository root:

```sh
./docs/validation/churn-explanation.sh
npm test
```

The script runs two probes:

1. **Two runs, one edited input.** It samples once with `src/input.txt`
   containing `A`, edits the file to `B`, and samples again. There is no warm
   hit yet, so the verdict is `cache-never-hits`; the point is that the report
   names the edited path and explains that the key changed with it.
2. **The churn case.** It samples cold, samples warm with the same input,
   edits `src/input.txt` to `B`, and samples a third time. Two keys and one hit
   produce `cache-churns`, and the report must name the edited path in both the
   changed-input line and the reason.

Both probes also read `report --json` and assert that `inputChanges.paths` is
exactly `["src/input.txt"]` and that `changes[0]` is `modified` with different
before/after hashes.

## Output

The full script output from the run recorded here (timings vary by machine):

```console
$ ./docs/validation/churn-explanation.sh
== Probe 1: two runs with one edited input ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.0 ms
  build:   222.8 ms
  total:   222.8 ms
  size:    17 bytes

Edit src/input.txt (A -> B), then take the second sample:
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:75c29bcedcf0edf9cab4d8df8d35bdfd10e57e10a62dfa2223a6633601b67bf6
  command: node build.mjs
  restore: 0.0 ms
  build:   220.7 ms
  total:   220.7 ms
  size:    17 bytes

== Two-run report: no hit yet, but the changed path is named ==
Runs: 2 (0 hits, 2 misses)
Hit rate: 0.0%
Median cold total: 221.7 ms
Median warm total: n/a
Restore cost: n/a
Net ms per hit: n/a
Cache size: 34 B across 2 stored keys
Changed inputs since previous sample: src/input.txt (modified)
Verdict: cache-never-hits
Reason: the cache is populated (17 B of cache artifacts were written) but no run restored it; the key changed with src/input.txt (modified), so the build stored a new key instead of restoring the previous one

== Probe 2: cold, warm, then the same edit ==
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.0 ms
  build:   218.4 ms
  total:   218.4 ms
  size:    17 bytes
warm build: reused the artifact
cache-verdict: HIT (warm)
  key:     sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c
  command: node build.mjs
  restore: 0.9 ms
  build:   72.2 ms
  total:   73.1 ms
  size:    17 bytes

Report before the edit:
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 218.4 ms
Median warm total: 73.1 ms
Restore cost: 0.9 ms
Net ms per hit: 145.2 ms
Cache size: 17 B across 1 stored key
Changed inputs since previous sample: none
Verdict: cache-pays
Reason: warm builds are 145.2 ms faster per hit after paying the restore cost

Edit src/input.txt (A -> B), then take a third sample:
cold build: computed the artifact
cache-verdict: MISS (cold)
  key:     sha256:75c29bcedcf0edf9cab4d8df8d35bdfd10e57e10a62dfa2223a6633601b67bf6
  command: node build.mjs
  restore: 0.0 ms
  build:   224.0 ms
  total:   224.0 ms
  size:    17 bytes

== Churn report: the key changed, so the cache churns ==
Runs: 3 (1 hit, 2 misses)
Hit rate: 33.3%
Median cold total: 221.2 ms
Median warm total: 73.1 ms
Restore cost: 0.9 ms
Net ms per hit: 148.0 ms
Cache size: 34 B across 2 stored keys
Changed inputs since previous sample: src/input.txt (modified)
Verdict: cache-churns
Reason: 2 distinct keys across 3 samples; the cache key changes too often to accumulate hits; the last two samples changed src/input.txt (modified)

== Changed inputs from report --json ==
{
  "available": true,
  "reason": null,
  "previousKey": "sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c",
  "currentKey": "sha256:75c29bcedcf0edf9cab4d8df8d35bdfd10e57e10a62dfa2223a6633601b67bf6",
  "previousTimestamp": "2026-11-09T17:15:37.285Z",
  "currentTimestamp": "2026-11-09T17:15:37.657Z",
  "paths": [
    "src/input.txt"
  ],
  "changes": [
    {
      "path": "src/input.txt",
      "change": "modified",
      "before": "06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0",
      "after": "c0cde77fa8fef97d476c10aad3d2d54fcc2f336140d073651c2dcccf1e379fd6"
    }
  ],
  "truncated": false
}

== Churn ledger keys and the src/input.txt hash (trimmed) ==
{"key":"sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c","hit":false,"input":"06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0"}
{"key":"sha256:65a42774beb891b8c95ed450e26b11bd478cc5012dee1767742ad3d5a6d6c60c","hit":true,"input":"06f961b802bc46ee168555f066d28f4f0e9afdf3f88174c1ee6f9de004fc30a0"}
{"key":"sha256:75c29bcedcf0edf9cab4d8df8d35bdfd10e57e10a62dfa2223a6633601b67bf6","hit":false,"input":"c0cde77fa8fef97d476c10aad3d2d54fcc2f336140d073651c2dcccf1e379fd6"}

PASS: both reports named src/input.txt (modified), and the churn report explained the key change.
```

The console block above shows the `inputChanges` object from the full
`report --json` output; the script prints that subset. The hashes match the
ledger rows: the first two samples keep the same key and the same
`src/input.txt` hash, while the third sample's key and file hash both change.

`npm test` on the same checkout: `tests 32`, `pass 32`, `fail 0`.

## What this proves

- A two-run probe with one edited input names `src/input.txt (modified)` in the
  report, even though the verdict is still `cache-never-hits`.
- A cold, warm, edit, cold sequence reaches `cache-churns`, and the reason names
  the edited path instead of asking the user to compare opaque key hashes.
- `report --json` exposes the same evidence as `inputChanges.paths` and
  `inputChanges.changes`, with distinct before/after hashes.
- The ledger now contains the per-file hashes the comparison needs, so the
  explanation is reproducible from the recorded samples rather than inferred.
- When the recorded inputs are unchanged, the report says
  `Changed inputs since previous sample: none` instead of inventing churn (the
  pre-edit report in Probe 2).

## What this does not cover

- The timings are from one machine. They show that the cold and warm paths ran,
  not how fast any real project's cache is.
- It uses one small Node.js build. Cargo, Gradle, Next.js, npm, Python, and Go
  detection are covered by `npm test`, not by this record.
- It does not exercise the 500-file / 48 KiB recording bound or a ledger written
  before input recording. `npm test` covers both; an old ledger reports the
  comparison as unavailable instead of guessing.
- It runs the checkout, not the published `cache-verdict@0.2.0` tarball. Input
  recording is in the Unreleased section, so this probe should be rerun against
  the next published artifact.
