# Validation: savings policy from a clean install

`cache-verdict check` can now enforce a savings policy from
`.cache-verdict.json` and from `--min-net-ms` / `--max-restore-ms`. This record
proves the behavior through a clean `npm pack` + install rather than through
the source checkout:

- a policy of `minNetMsPerHit: 500` exits **4** and prints the shortfall when
  the measured net saving is below it;
- the same samples exit **0** with a permissive `minNetMsPerHit: 0` policy;
- `--min-net-ms 0` overrides a strict config threshold and exits **0**;
- the installed `check --help` shows both override flags and exit code 4.

The timing numbers below are from one machine. The policy result depends on
the saved milliseconds, not on a fixed benchmark; the fixture deliberately
builds much faster on the warm path than the cold path, so the strict policy
fails by a wide margin on any reasonable machine.

## Artifact and environment

- Packed from this checkout with `npm pack`; the tarball contains the merged
  policy code in `bin/cache-verdict.mjs`, `lib/policy.mjs`, and `lib/config.mjs`.
  `package.json` still says `0.4.0` because this change is unreleased.
- Tarball: `cache-verdict-0.4.0.tgz`, size 42.3 kB, 19 files.
- SHA-256:
  `218be400e2e0a03f68f5d4495725ea0424e3b58e326515433bab8f6efcdc4de9`.
- npm shasum: `9f0a75e7393cd2325e7ac9de0c94a7ba7994d3c4`.
- macOS, Darwin arm64; Node.js v24.15.0, npm 11.12.1.
- Recorded on 2026-11-11.
- No network was needed: the tarball has no runtime dependencies.

## Pack and install

```console
$ npm pack --pack-destination "$work/pack"
...
npm notice name: cache-verdict
npm notice version: 0.4.0
npm notice filename: cache-verdict-0.4.0.tgz
npm notice package size: 42.3 kB
npm notice unpacked size: 151.5 kB
npm notice total files: 19
cache-verdict-0.4.0.tgz

$ npm install "$work/pack/cache-verdict-0.4.0.tgz" --no-audit --no-fund --ignore-scripts
added 1 package in 123ms

$ node node_modules/cache-verdict/bin/cache-verdict.mjs --version
0.4.0
```

The installed `check --help` includes the policy flags and the new exit code:

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs check --help
...
  cache-verdict check [directory] [--json] [--ledger <path>]
                      [--min-net-ms <ms>] [--max-restore-ms <ms>]
...
      --min-net-ms <ms> Fail unless at least this many milliseconds are saved
                        per hit; overrides policy.minNetMsPerHit.
      --max-restore-ms <ms>
                        Fail when the median restore takes more than this many
                        milliseconds; overrides policy.maxRestoreMs.
...
  4  check missed a threshold in the configured savings policy
```

## Fixture

A small npm project writes a 6-byte artifact under
`node_modules/.cache/policy-probe/`. Its build sleeps 300 ms cold and 100 ms
warm, so the cache pays, but not by 500 ms per hit. The config was written by
the installed `init` and then given this policy:

```json
"policy": {
  "minNetMsPerHit": 500
}
```

Two real samples produced one cold miss and one warm hit:

```console
cache-verdict: MISS (cold)
  key:     sha256:af9d33c1b8411541bb060665afb47455cbfb761843a569c1dbf9267ef37e8d23
  command: npm run build
  restore: 0.0 ms
  build:   475.0 ms
  total:   475.0 ms
  size:    6 bytes

cache-verdict: HIT (warm)
  key:     sha256:af9d33c1b8411541bb060665afb47455cbfb761843a569c1dbf9267ef37e8d23
  command: npm run build
  restore: 0.9 ms
  build:   268.4 ms
  total:   269.3 ms
  size:    6 bytes
```

## Strict policy: exit 4 with the shortfall

The measured net saving is 205.7 ms per hit, below the configured 500 ms.

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs check .
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 475.0 ms
Median warm total: 269.3 ms
Restore cost: 0.9 ms
Net ms per hit: 205.7 ms
Cache size: 6 B across 1 stored key
Changed inputs since previous sample: none
Policy: min net 500.0 ms per hit
Policy failure: policy.minNetMsPerHit missed: measured 205.7 ms saved per hit, needs at least 500.0 ms (shortfall 294.3 ms)
Verdict: cache-pays
Reason: warm builds are 205.7 ms faster per hit after paying the restore cost
cache-verdict: policy.minNetMsPerHit missed: measured 205.7 ms saved per hit, needs at least 500.0 ms (shortfall 294.3 ms)
$ echo $?
4
```

The report still says `Verdict: cache-pays`: the cache does pay, but it does not
meet the team's minimum. The policy failure is printed on stdout in the report
and again on stderr, so a CI log shows both the number and the shortfall.

## Permissive policy: exit 0

Changing only the policy threshold to `0` makes the same samples pass:

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs check .
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 475.0 ms
Median warm total: 269.3 ms
Restore cost: 0.9 ms
Net ms per hit: 205.7 ms
Cache size: 6 B across 1 stored key
Changed inputs since previous sample: none
Policy: min net 0.0 ms per hit
Verdict: cache-pays
Reason: warm builds are 205.7 ms faster per hit after paying the restore cost
$ echo $?
0
```

## Command-line override: exit 0

With the strict `500` threshold back in the config, the per-check override
wins for that threshold:

```console
$ node node_modules/cache-verdict/bin/cache-verdict.mjs check . --min-net-ms 0
...
Policy: min net 0.0 ms per hit
Verdict: cache-pays
$ echo $?
0
```

The override does not rewrite the config; it applies to that invocation only.
The other threshold, if configured, remains in effect.

## What this verifies and what it does not

Verified:

- the packed and installed CLI exposes the policy flags and exit code 4;
- a positive-but-too-small saving no longer passes `check` when the project
  configures a minimum;
- the failure names the measured value, the limit, and the shortfall;
- a permissive policy and a per-check override both turn the same samples into
  exit 0;
- the policy is read from `.cache-verdict.json` written by the installed
  `init`, and the report still shows the underlying `cache-pays` verdict.

Not covered here:

- GitHub's cache service, a full CI run, or restore performance across
  machines; [the generated-recipe validation](github-action-recipe.md) covers
  the workflow shape and local command sequence.
- Every ecosystem's `cachePath`; the policy compares the numbers all
  ecosystems already report.
- Thresholds with no usable measurement. A missing `netMsPerHit` or
  `restoreMs` is skipped rather than treated as a pass or a failure; `check`
  exits 3 first when it needs more samples.

The deterministic counterpart in `npm test` is
`test/policy-install.test.mjs`: it packs and installs the package, then writes
a fixed cold/warm ledger so the 75 ms measurement and 25 ms shortfall do not
depend on machine speed. It asserts the same exit 4, shortfall text, permissive
exit 0, and `--min-net-ms` override against the installed artifact.

## Reproduce

From the repository root:

```sh
docs/validation/savings-policy.sh
```

The script creates its own temporary projects, uses a private npm cache, and
removes everything on exit. It prints the tarball hash, the installed version,
the relevant help lines, both build samples, and the three check results.

For just the deterministic clean-install test:

```sh
node --test test/policy-install.test.mjs
```
