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

1. Run `pnpm release:prepare X.Y.Z`, update `CHANGELOG.md`, and merge the release PR. Dispatch **Stable release**
   immediately for the exact `main` commit; the workflow waits for that commit's complete CI run to turn green.
   CI preserves the exact tested npm tarballs for that source commit.
2. For the first release only, publish with an `NPM_TOKEN` secret in the `npm` GitHub environment. npm requires
   packages to exist before a trusted publisher can be attached. After bootstrap, configure npm trusted publishing
   for `release.yml`, repository `burakgon/roamcode`, environment `npm`, and all three packages; then delete the token.
3. Configure `HOMEBREW_TAP_DEPLOY_KEY` as a write-enabled deploy key for `burakgon/homebrew-roamcode`.
4. The dispatch fails closed when exact-commit CI fails, the package candidate is missing, or `main` advances before
   publication starts.

The main CI workflow runs two balanced test shards, static quality checks, the website checks, and stable-candidate
packaging in parallel. The candidate job installs the exact three tarballs into a clean Node container and exercises
pairing, native PTY/SQLite, terminal input, needs-input signaling, durable restart adoption, and duplicate-free reconnect. The
tested tarballs are checksummed, attested, and stored under the source commit.

The stable workflow does no compilation, browser testing, or package packing. It waits for the exact CI run,
downloads and verifies those successful candidate bytes and attestations, then publishes `@roamcode.ai/web`,
`@roamcode.ai/server`, and `roamcode` with npm provenance. `roamcode-release.json` binds npm integrities to the
stable version. The workflow updates the Homebrew tap and creates the non-prerelease GitHub Release last.

Mobile browser contracts run independently from static quality checks so both consume the same CI window. The stable
candidate installs its packed artifacts in an isolated container, including tmux and native dependencies; the host
candidate job deliberately avoids duplicating that environment setup. Release checkout is shallow because tag
existence is checked against the remote directly.

Independent candidate attestations are verified concurrently. npm packages still publish and verify in dependency
order so `latest` never points at a CLI whose exact server or web dependency is unavailable; registry visibility is
polled at short intervals under the same bounded overall wait. The packed acceptance fixtures answer the same
non-interactive capability and authentication probes as their real CLIs, avoiding timeout-driven CI delays.

This ordering prevents clients from discovering a release before every install artifact exists. A failed workflow
before the final step is not OTA-visible and can be resumed after the underlying publication or tap issue is
corrected. Existing npm versions are verified and reused, never overwritten; never reuse an already-published
version for different bytes.

`install-smoke.yml` remains the clean public-path check. It runs weekly, on installer changes, and on demand. Dispatch
it after releases that change installation, OTA, package layout, native dependencies, or release infrastructure; the
packed-runtime candidate is sufficient for routine UI-only releases, which should not add a redundant post-release
installer wait.
