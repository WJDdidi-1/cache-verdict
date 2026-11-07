# Releasing cache-verdict

A release is a `v<version>` tag plus the GitHub release that carries the notes.
The tag is also the publish trigger: [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
is the only publisher, and it uses npm trusted publishing (OIDC), so no npm
token is stored in the repository.

## Before tagging

1. Decide the next version using SemVer. The version in `package.json` and
   `package-lock.json` must already be that version on `main`.
2. Run the same checks the workflow runs:

   ```sh
   npm ci
   npm test
   npm pack --dry-run
   ```

3. Confirm the tag will match the manifest. The workflow rejects a tag whose
   name after `v` is not exactly `package.json`'s `version`:

   ```sh
   node -p "require('./package.json').version"
   ```

4. Merge the release prep to `main` and wait for CI to pass. Do not tag a
   feature branch.
5. Write `docs/releases/v<version>.md` from the actual merged changes and the
   real test output. Do not add numbers, users, or benchmarks that were not
   measured.

## Creating the tag and release

For version 0.1.0 the tag is `v0.1.0`:

```sh
git tag -a v0.1.0 -m "cache-verdict v0.1.0"
git push origin v0.1.0

gh release create v0.1.0 \
  --title "cache-verdict v0.1.0" \
  --notes-file docs/releases/v0.1.0.md
```

Only the tag push is required to start the publish workflow. The GitHub release
is what makes the version visible on the repository's Releases page, so create
it from the same tag and the notes file.

## What the workflow does

1. Verifies that `v<tag>` equals `package.json`'s `version`.
2. Runs `npm test`, packs the tarball, checks that no secret or stray files are
   in it, and installs the tarball into a clean directory.
3. Publishes the verified tarball to npm with provenance if that version is not
   already on the registry.
4. Polls the registry until it serves the version.

The `npm-publish` environment and the npm trusted publisher must already be
configured in the repository settings; this checklist does not change them.

## Verify the release

```sh
npm view cache-verdict version
npm install -g cache-verdict@0.1.0
cache-verdict --version
```

Also open the GitHub release page and confirm that the tag points at the commit
you intended and that the notes render. A local `git tag` that was never pushed
is not a release, and a publish command that exited zero is not a release until
the registry serves the version.

## If something is wrong

Fix forward with a new version when possible. If a tag is wrong and has not
been announced, delete the tag and the GitHub release before creating the
corrected tag; never move a public tag to a different commit silently.
