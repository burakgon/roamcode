# Stable releases

RoamCode has one release identity: stable SemVer (`X.Y.Z`). The CLI, server, web bundle, npm packages,
GitHub tag/release, managed release directory, and Homebrew formula must all carry the same version.
Commit SHAs and branch heads are development metadata, never OTA targets.

## Hosted-cloud compatibility gate

The hosted account service, the digest-pinned gateway/site image, and the installable Node are independently deployed. A change
that crosses those boundaries must not rely on version strings or on all three deployments landing together. The
Node heartbeat advertises behavior only when it is actually operational; managed browser enrollment requires
`terminal.v1`, `relay.v1`, and `managed-device-enrollment.v1`. The account service must refuse enrollment for an
older or degraded Node instead of issuing a flow that can only fail later.

For a stable release that changes a hosted contract, use this order:

1. Publish and deploy an immutable, attested account-service image by digest. Run migrations first. The new service
   must remain backward-compatible with the currently stable Node and keep new entry points dark.
2. Build the gateway/site image from the reviewed public commit and validate its production routing shape on an
   isolated single-VM stack. Do not expose its new account or terminal journey yet.
3. Complete the normal stable Node release below. Verify npm, Homebrew, the release manifest, and the final GitHub
   Release before treating the capability as available to users.
4. Activate the exact reviewed gateway/site digest in production and enable its account entry points. Smoke-test
   sign-in, own-access projection, Node capability gating, browser enrollment, a real terminal connection, and
   browser-device revocation.
5. Record the account image digest, public stable SemVer, gateway image digest, migration revision, and smoke result in the
   private deployment record. None of these identifiers is a substitute for the runtime capability gate.

Rollback the gateway/site image first if the user journey is broken. Keep backward-compatible account migrations and
readers deployed while the Node's verified previous release remains available through OTA rollback. Never roll back
to an account binary that cannot read data written by the new migration or active key epoch.

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
   commit's complete CI run to turn green; CI preserves attested npm tarballs and immutable source-SHA relay/gateway
   candidates for that commit.
2. For the first release only, publish with an `NPM_TOKEN` secret in the `npm` GitHub environment. npm requires
   packages to exist before a trusted publisher can be attached. After the bootstrap release, configure npm
   trusted publishing for `release.yml`, repository `burakgon/roamcode`, environment `npm`, and all three
   packages; then delete `NPM_TOKEN`.
3. Configure `HOMEBREW_TAP_DEPLOY_KEY` as a write-enabled deploy key for `burakgon/homebrew-roamcode`.
4. On the first cloud-image publication, the workflow creates the repository-linked `roamcode-relay` and
   `roamcode-edge` GHCR packages and stops before Homebrew or GitHub Release if anonymous pulls are not yet allowed.
   Change each package visibility to **Public** once in GitHub's package settings, then rerun the same workflow. Public
   GHCR package visibility is a one-time GitHub account setting and cannot currently be declared by the image build.
5. Dispatch **Stable release** with `X.Y.Z` from the exact reviewed `main` commit. The dispatch fails closed when the
   exact commit has no successful CI run or any expected candidate is missing.

The main CI workflow builds and tests once, requires the fresh hosted product build to pass its route, navigation,
layout, accessibility, and scroll contracts in both Chrome and actual Safari, installs the exact three tarballs into
a clean Node container, and exercises pairing, native PTY/SQLite, terminal input, attention, durable restart
adoption, and duplicate-free reconnect. The exact tested tarballs are checksummed, attested, and stored under the
source commit. In parallel, CI builds SBOM/provenance-attested ARM64 and amd64 relay/edge images under immutable
source-SHA references.

The stable workflow does no compilation, browser testing, package packing, or container building. It requires the
exact successful CI run, downloads and verifies those candidate bytes and attestations, then publishes
`@roamcode.ai/web`, `@roamcode.ai/server`, and `roamcode` with npm provenance. After npm succeeds, it promotes the
exact CI image digests to the stable SemVer only when that tag does not already exist.
`roamcode-release.json` and `roamcode-cloud-images.json` bind npm integrities and OCI digests to the same version and
source revision. The workflow then proves the images are anonymously pullable, updates the tap, and creates the
non-prerelease GitHub Release last.

This ordering prevents clients from discovering a release before every install artifact exists. A failed workflow
before the final step is not OTA-visible and can be resumed after the underlying publishing, visibility, or tap issue
is corrected. Existing npm versions and OCI version/commit tags are verified and reused, never overwritten; never
reuse an already-published version for different bytes.
