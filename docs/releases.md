# Stable releases

RoamCode has one release identity: stable SemVer (`X.Y.Z`). The CLI, server, web bundle, npm packages,
GitHub tag/release, managed release directory, and Homebrew formula must all carry the same version.
Commit SHAs and branch heads are development metadata, never OTA targets.

## User channels

- Foreground: `npx roamcode@latest`
- Permanent: `npx roamcode@latest install`
- Homebrew: `brew install burakgon/roamcode/roamcode`, then `roamcode install`
- Existing v0 checkout service: take the first v1 in-app update once; it migrates the service to the managed launcher.

Managed releases live under `~/.local/share/roamcode/releases/<version>`. `current` is atomically changed
only after npm integrity verification and an isolated `/health` boot smoke. `previous` retains the last good
release for the in-app rollback action. Operational data remains in `~/.config/roamcode`.

## Maintainer flow

1. Run `pnpm release:prepare X.Y.Z`, update `CHANGELOG.md`, and merge the release PR after CI is green.
2. Configure npm trusted publishing for `.github/workflows/release.yml` and the `npm` GitHub environment for
   each published package. No long-lived npm token is used.
3. Configure `HOMEBREW_TAP_TOKEN` with write access to `burakgon/homebrew-roamcode`.
4. Dispatch **Stable release** with `X.Y.Z` from the exact reviewed commit.

The workflow builds and tests once, publishes `@roamcode/web`, `@roamcode/server`, then `roamcode` with npm
provenance, derives `roamcode-release.json` from npm registry integrities, updates the tap, and creates the
non-prerelease GitHub Release last. This ordering prevents clients from discovering a release before its
install artifacts exist. A failed workflow before the final step is not OTA-visible and can be resumed after
the underlying publishing/tap issue is corrected; never reuse an already-published version for different bits.
