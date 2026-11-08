# Validation: cache-verdict 0.1.0 on an external Next.js project

This is the first end-to-end run of the published package on a project that is
not one of this repository's fixtures. The question was whether a user who runs
`npx cache-verdict@0.1.0` in a real npm project gets a working `init`, `run`,
`report`, and `check` flow.

## Artifact under test

- Package: `cache-verdict@0.1.0`
- Tarball: <https://registry.npmjs.org/cache-verdict/-/cache-verdict-0.1.0.tgz>
- npm shasum: `51f45bff0e012a1164a174008e5370db769195f9`
- npm integrity: `sha512-RnL+Tro8Z8VeVRyT7TsyAlLmFlPWa0D3SvAShGNX/o+n1RaCILQZY1mOInSU6kcKqI6yhQry2L1xcJWCmhgnGg==`
- Published: 2026-11-07T19:38:10Z
- `npx --yes cache-verdict@0.1.0 --version` printed `0.1.0`.

## Environment

- macOS 27.2
- Node.js v24.15.0
- npm 11.12.1
- Cold sample recorded at 2026-11-08T17:16:39.510Z
- Warm sample recorded at 2026-11-08T17:16:46.659Z

## The project

A fresh Next.js 15.5.29 App Router app outside this repository. It contained:

- `package.json` with `"build": "next build"` and exact dependencies on
  `next@15.5.29`, `react@19.3.1`, and `react-dom@19.3.1`;
- `next.config.mjs`;
- `app/layout.js` and `app/page.js`;
- a generated `package-lock.json`;
- no `.cache-verdict.json`, `.cache-verdict/`, or `.next/cache` before `init`.

The project had two routes (`/` and the generated `/_not-found`). Nothing in it
was written for cache-verdict; `.next/cache` is Next.js's own build cache.

## Commands

From the project directory:

```sh
npx --yes cache-verdict@0.1.0 init
npx --yes cache-verdict@0.1.0 run
npx --yes cache-verdict@0.1.0 run
npx --yes cache-verdict@0.1.0 report
npx --yes cache-verdict@0.1.0 check >/dev/null; echo $?
```

## Output

`init` detected Next.js from `package.json` and `next.config.mjs`, wrote the
config below, and reported the generic npm detector as an alternative.

```console
$ npx --yes cache-verdict@0.1.0 init
Detected Next.js from package.json, next.config.mjs.
Wrote .cache-verdict.json.
Also detected: npm. Use --ecosystem to choose one instead.
note: Next.js stores build output in .next/cache; this path is measured.
Review "command", "inputs", and "cachePath" before sampling.
```

The reviewed config was left as written:

```json
{
  "schemaVersion": 1,
  "ecosystem": "nextjs",
  "displayName": "Next.js",
  "command": "npm run build",
  "inputs": [
    "package.json",
    "package-lock.json",
    "next.config.mjs",
    "app/**",
    "pages/**",
    "src/**",
    "public/**"
  ],
  "cachePath": [
    ".next/cache"
  ],
  "detectedFrom": [
    "package.json",
    "next.config.mjs"
  ],
  "notes": [
    "Next.js stores build output in .next/cache; this path is measured."
  ]
}
```

The cold sample moved the nonexistent `.next/cache` aside, ran the build, and
stored the produced cache. The warm sample restored that cache before building.

```console
$ npx --yes cache-verdict@0.1.0 run
... Next.js build output omitted ...
cache-verdict: MISS (cold)
  key:     sha256:83b79b1063935dc084c2c3b2f2b018e2dac8848abfff92617679f044ba8e8bc6
  command: npm run build
  restore: 0.0 ms
  build:   7465.6 ms
  total:   7465.6 ms
  size:    46735665 bytes

$ npx --yes cache-verdict@0.1.0 run
... Next.js build output omitted ...
cache-verdict: HIT (warm)
  key:     sha256:83b79b1063935dc084c2c3b2f2b018e2dac8848abfff92617679f044ba8e8bc6
  command: npm run build
  restore: 14.6 ms
  build:   5053.9 ms
  total:   5068.5 ms
  size:    48814564 bytes
```

The report and gate:

```console
$ npx --yes cache-verdict@0.1.0 report
Runs: 2 (1 hit, 1 miss)
Hit rate: 50.0%
Median cold total: 7465.6 ms
Median warm total: 5068.5 ms
Restore cost: 14.6 ms
Net ms per hit: 2397.1 ms
Cache size: 46.6 MiB across 1 stored key
Verdict: cache-pays
Reason: warm builds are 2397.1 ms faster per hit after paying the restore cost

$ npx --yes cache-verdict@0.1.0 check >/dev/null; echo $?
0
```

`check` printed the same report to stdout and exited 0. The current checkout,
which includes the post-0.1.0 report fix, reads the same ledger and prints the
same report and exit code.

## Ledger

The two ledger rows, trimmed to the measurement fields:

```json
{"key":"sha256:83b79b1063935dc084c2c3b2f2b018e2dac8848abfff92617679f044ba8e8bc6","hit":false,"buildMs":7465.626,"restoreMs":0,"totalMs":7465.626,"sizeBytes":46735665,"stored":true}
{"key":"sha256:83b79b1063935dc084c2c3b2f2b018e2dac8848abfff92617679f044ba8e8bc6","hit":true,"buildMs":5053.866,"restoreMs":14.618,"totalMs":5068.484,"sizeBytes":48814564,"stored":true}
```

## What the measurement shows

The published package completed the full flow on a project outside the
repository. The key was stable across the two runs, the warm run restored
46,735,665 bytes of Next.js cache in 14.6 ms, and the end-to-end build was
2,397.1 ms faster. The cache paid for this key, so `check` exited 0.

These are two samples on one machine, not a benchmark. The timings include
Next.js compilation, type checking, page generation, and tracing. Another
machine, a different Next.js version, or a larger app will produce different
numbers; run the same four commands before making a decision.

## What this run did not cover

- It exercised Next.js only, not Cargo, Gradle, npm, Python, or Go.
- It took one cold and one warm sample; it did not exercise `run --cold`,
  `prune`, churn, or a cache that never hits. The repository's tests cover
  those paths.
- The published 0.1.0 tarball predates the clearer empty-`cachePath` report
  merged in #7 (`b904b2c`). This project's cache was populated, so the run was
  unaffected. The registry still serves the pre-fix tarball; users get that
  diagnostic with the next published version.
