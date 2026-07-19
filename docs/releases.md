# Stable releases

RoamCode has one release identity: stable SemVer (`X.Y.Z`). The CLI, server, web bundle, npm packages,
GitHub tag/release, managed release directory, and Homebrew formula must all carry the same version.
Commit SHAs and branch heads are development metadata, never OTA targets.

## User channels

- Foreground: `npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest`
- Permanent: `npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install`
- Homebrew: `brew install burakgon/roamcode/roamcode`, then `roamcode install`
- Existing v0 checkout service: take the first v1 in-app update once; it migrates the service to the managed launcher.

Managed releases live under `~/.local/share/roamcode/releases/<version>`. `current` is atomically changed
only after npm integrity verification and an isolated `/health` boot smoke. `previous` retains the last good
release for the in-app rollback action. Operational data remains in `~/.config/roamcode`.

## Maintainer flow

1. Run `pnpm release:prepare X.Y.Z`, update `CHANGELOG.md`, and merge the release PR. Wait for the exact `main`
   commit's complete CI run to turn green. CI preserves the exact tested npm tarballs for that source commit.
2. For the first release only, publish with an `NPM_TOKEN` secret in the `npm` GitHub environment. npm requires
   packages to exist before a trusted publisher can be attached. After bootstrap, configure npm trusted publishing
   for `release.yml`, repository `burakgon/roamcode`, environment `npm`, and all three packages; then delete the token.
3. Configure `HOMEBREW_TAP_DEPLOY_KEY` as a write-enabled deploy key for `burakgon/homebrew-roamcode`.
4. Dispatch **Stable release** with `X.Y.Z` from the exact reviewed `main` commit. The dispatch fails closed when the
   exact commit has no successful CI run or the package candidate is missing.

The main CI workflow builds and tests once, installs the exact three tarballs into a clean Node container, and
exercises pairing, native PTY/SQLite, terminal input, attention, durable restart adoption, and duplicate-free
reconnect. The tested tarballs are checksummed, attested, and stored under the source commit.

The stable workflow does no compilation, browser testing, or package packing. It requires the exact successful CI
run, downloads and verifies those candidate bytes and attestations, then publishes `@roamcode.ai/web`,
`@roamcode.ai/server`, and `roamcode` with npm provenance. `roamcode-release.json` binds npm integrities to the
stable version. The workflow updates the Homebrew tap and creates the non-prerelease GitHub Release last.

This ordering prevents clients from discovering a release before every install artifact exists. A failed workflow
before the final step is not OTA-visible and can be resumed after the underlying publication or tap issue is
corrected. Existing npm versions are verified and reused, never overwritten; never reuse an already-published
version for different bytes.
