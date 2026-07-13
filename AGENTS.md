# Repository instructions for coding agents

These instructions apply to the entire repository. This is a public repository: write every file, commit,
log, issue, release note, and command as if it will be visible to anyone on the internet.

## Public-repository safety

- Never commit, print, paste, or request credentials, access tokens, cookies, private keys, `.npmrc` contents,
  signing material, or authenticated URLs. Use the existing GitHub environments and trusted publishing.
- Never add a maintainer's username, home directory, machine-specific absolute path, private hostname, tunnel URL,
  session identifier, or production log contents to the repository.
- Keep local service data, live sessions, and unrelated worktree changes intact. Do not clean, reset, or overwrite
  changes that are outside the requested task.
- Do not mutate or restart a developer's installed RoamCode service merely to test a change. A live install, manual
  migration, rollback, or restart requires an explicit user request. Use isolated tests and GitHub Actions for boot
  and package-install smoke tests.

## Stable release and OTA contract

- A commit or push to `main` is not an update. Users discover updates only through stable, non-draft GitHub Releases.
- Stable SemVer (`X.Y.Z`) is the only release identity. The workspace, CLI, server, web package, npm artifacts,
  GitHub tag/release, release manifest, and Homebrew formula must agree on the exact version.
- The stable release workflow must publish npm artifacts and the Homebrew formula before it creates the discoverable
  GitHub Release. Never manually reverse this order.
- OTA installs the exact npm version whose integrity is recorded in `roamcode-release.json`; do not reintroduce
  commit-, branch-, or checkout-based update behavior.
- Release descriptions are user-facing OTA data. `scripts/release-notes.mjs` extracts them from `CHANGELOG.md`, and
  the web client groups their Markdown bullets under headings such as `Added`, `Fixed`, and `Changed`. Every release
  section must contain at least one accurate bullet so **What's new** is never empty.
- Never reuse a published version for different package bytes. If a workflow fails, first determine which external
  artifacts exist; resume only when the workflow can prove any existing immutable npm artifacts match exactly.

## Releasing a stable version

Only perform release mutations—version bump, release commit, push, workflow dispatch, tag, or external
publication—when the user explicitly asks to release or publish. For implementation-only requests, prepare and
verify the change but leave publication to the user.

The canonical design and channel details are in `docs/releases.md`. When a release is authorized:

1. Inspect the worktree and current releases. Preserve unrelated user changes and choose the next unused stable
   SemVer version.
2. Move the relevant notes from `CHANGELOG.md`'s `Unreleased` section into `## [X.Y.Z] - YYYY-MM-DD`. Write concise,
   user-facing Markdown bullets describing actual behavior; do not use commit messages as release notes.
3. Run `pnpm release:prepare X.Y.Z`. Confirm all four package manifests carry the same version and review the
   resulting diff.
4. Run proportionate local checks, including formatting, lint, type checking, relevant unit tests, and package builds.
   Do not use the developer's live service or default tmux/data locations as a test fixture.
5. Commit only the intended release scope and push the reviewed commit to `main`.
6. Dispatch the single release orchestrator:

   ```sh
   gh workflow run release.yml -f version=X.Y.Z
   ```

7. Monitor that exact workflow run through tests, packing, packed-layout smoke, npm publication, manifest creation,
   Homebrew update, and the final GitHub Release step. Do not report success while the run is queued or partial.
8. Verify the final GitHub Release has `roamcode-release.json` and non-empty notes, all three npm packages resolve to
   `X.Y.Z`, and the Homebrew formula references `X.Y.Z`.

Do not run `npm publish`, create the stable GitHub Release, push a release tag, or edit the Homebrew tap by hand during
the normal flow. `.github/workflows/release.yml` is the release authority and creates the GitHub Release last.

## OTA changes

When changing the updater or its UI, preserve these invariants:

- A detached helper must report durable progress and an early exit must become an explicit failure, never an endless
  `Starting…` state.
- The client tracks the accepted operation id and target version, ignores stale status from older attempts, persists
  an in-flight operation across PWA reloads, and also treats the running target version as authoritative success.
- Planned restart disconnects are shown as reconnecting. Hiding the detail sheet must leave compact progress visible.
- The previous verified release remains available for rollback, and activation happens only after package integrity
  checks and an isolated boot smoke.
- Add or update tests for helper packaging, lifecycle reconciliation, reload recovery, stale-operation rejection,
  failure reporting, and user-facing progress copy.
