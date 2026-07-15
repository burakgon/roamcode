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

1. Run `pnpm release:prepare X.Y.Z`, update `CHANGELOG.md`, and merge the release PR after CI is green.
2. For the first release only, publish with an `NPM_TOKEN` secret in the `npm` GitHub environment. npm requires
   packages to exist before a trusted publisher can be attached. After the bootstrap release, configure npm
   trusted publishing for `release.yml`, repository `burakgon/roamcode`, environment `npm`, and all three
   packages; then delete `NPM_TOKEN`.
3. Configure `HOMEBREW_TAP_DEPLOY_KEY` as a write-enabled deploy key for `burakgon/homebrew-roamcode`.
4. On the first cloud-image publication, the workflow creates the repository-linked `roamcode-relay` and
   `roamcode-edge` GHCR packages and stops before Homebrew or GitHub Release if anonymous pulls are not yet allowed.
   Change each package visibility to **Public** once in GitHub's package settings, then rerun the same workflow. Public
   GHCR package visibility is a one-time GitHub account setting and cannot currently be declared by the image build.
5. Dispatch **Stable release** with `X.Y.Z` from the exact reviewed commit.

The workflow builds and tests once, installs the exact three tarballs into a clean Node container, and exercises
pairing, native PTY/SQLite, terminal input, attention, durable restart adoption, and duplicate-free reconnect before
publishing `@roamcode.ai/web`, `@roamcode.ai/server`, then `roamcode` with npm provenance. It builds
SBOM/provenance-attested ARM64 and amd64 relay/edge images and publishes immutable commit-digest sources. After npm
succeeds, it promotes those exact digests to the stable SemVer only when that tag does not already exist.
`roamcode-release.json` and `roamcode-cloud-images.json` bind npm integrities and OCI digests to the same version and
source revision. The workflow then proves the images are anonymously pullable, updates the tap, and creates the
non-prerelease GitHub Release last.

This ordering prevents clients from discovering a release before every install artifact exists. A failed workflow
before the final step is not OTA-visible and can be resumed after the underlying publishing, visibility, or tap issue
is corrected. Existing npm versions and OCI version/commit tags are verified and reused, never overwritten; never
reuse an already-published version for different bytes.
