# npm build-cache example

A tiny npm project with a deliberately slow cold build and a fast warm build.
`cache-verdict` can show the difference in numbers instead of a hit counter.

- `src/input.txt` is the input. Editing it changes the cache key.
- `build.mjs` reads `src/input.txt`, writes an artifact to
  `node_modules/.cache/`, and spends 700 ms "compiling" only when that artifact
  is missing. The cache path `node_modules/.cache` is what `cache-verdict`
  moves aside, restores, sizes, and stores.
- `package.json` provides the `npm run build` command that `init` detects.

## Run it from the repository root

```sh
npm run example
```

That copies this directory to a temporary directory, runs `init`, two `run`
samples, and `report` with the checkout's CLI, then checks that the verdict is
`cache-pays`. The temporary copy is removed afterwards, so nothing is written
into the repository.

## Run it by hand

From this directory:

```sh
node ../../bin/cache-verdict.mjs init
node ../../bin/cache-verdict.mjs run
node ../../bin/cache-verdict.mjs run
node ../../bin/cache-verdict.mjs report
```

The first `run` is a cold miss and does the slow work. The second restores the
stored cache, and the report should say `cache-pays`. `.cache-verdict/` and
`dist/` are ignored by Git; delete them to start over.

Expected shape of the output (timings vary by machine):

```console
$ node ../../bin/cache-verdict.mjs run
...
cache-verdict: MISS (cold)
...
$ node ../../bin/cache-verdict.mjs run
...
cache-verdict: HIT (warm)
...
$ node ../../bin/cache-verdict.mjs report
Runs: 2 (1 hit, 1 miss)
...
Verdict: cache-pays
```

If the report says `cache-costs` or `cache-churns`, the cache is not paying for
itself for this key; that is the decision the tool exists to make. To see a
churn, edit `src/input.txt` between runs and `run` again: the key changes, so
the next build is cold.

## What `init` writes

`init` detects npm from `package.json` and writes this reviewable config:

```json
{
  "schemaVersion": 1,
  "ecosystem": "npm",
  "displayName": "npm",
  "command": "npm run build",
  "inputs": [
    "package.json",
    "*.js",
    "*.mjs",
    "*.cjs",
    "*.ts",
    "*.tsx",
    "*.jsx",
    "src/**",
    "lib/**",
    "bin/**",
    "scripts/**"
  ],
  "cachePath": ["node_modules/.cache"],
  "detectedFrom": ["package.json"],
  "notes": [
    "npm's download cache defaults to ~/.npm; set npm_config_cache=.npm in CI to keep it project-local and measurable."
  ]
}
```

The note is about npm's package-download cache, which this example does not
measure. The measured cache is `node_modules/.cache`, written by `build.mjs`.
Edit `command`, `inputs`, or `cachePath` if the detection does not match the
build you care about, then sample again with a fresh directory.
