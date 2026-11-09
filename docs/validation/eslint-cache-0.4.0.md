# Measured: a real build cache that pays

`cache-verdict` is only useful if it can tell a cache that pays from one that
does not. Both directions were measured on `cache-verdict@0.4.0` against a real
tool rather than a fixture.

## Setup

- 40 small ES modules under `src/`.
- `build` = `eslint --cache --cache-location node_modules/.cache/eslint/.eslintcache src`
  (ESLint's own cache: the second run skips re-linting unchanged files).
- `cachePath` = `node_modules/.cache`, the default for a Node project.
- `CACHE_VERDICT_STORE` pointed at a fresh directory, so run 1 was cold.

## Result

| sample | restore | build | total | cache size |
| --- | --- | --- | --- | --- |
| cold | 0.0 ms | 498.5 ms | 498.5 ms | — |
| warm | 0.8 ms | 235.0 ms | 235.7 ms | 11.9 KiB |

`report`:

```
Restore cost: 0.8 ms
Net ms per hit: 262.8 ms
Cache size: 11.9 KiB across 1 stored key
Changed inputs since previous sample: none
Verdict: cache-pays
Reason: warm builds are 262.8 ms faster per hit after paying the restore cost
```

`check` exits `0`, so the same command can gate CI.

## Why this matters

The earlier measurements in this repository were misses: a project whose cache
is never restored (`cache-never-hits`) or never written (`cachePath is empty`).
This run is the opposite case — the cache is written, restored, and pays for
itself — and the verdict, the net-per-hit number and the exit code all agree
with what the tool actually did. The `eslint` cache is a plain directory under
`node_modules/.cache`, so the measurement did not need a special code path.

## Reproduce

```sh
mkdir -p src && for i in $(seq 1 40); do printf 'export const x%d = %d;\n' "$i" "$i" > src/f$i.js; done
npm install --no-audit --no-fund eslint
npx cache-verdict init .
npx cache-verdict run .   # cold
npx cache-verdict run .   # warm
npx cache-verdict report .
npx cache-verdict check .  # exit 0
```

Numbers depend on the machine; the verdict should not.
