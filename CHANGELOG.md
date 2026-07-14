# Changelog

RoamCode ships stable SemVer releases through npm, GitHub Releases, the Homebrew tap, and in-app OTA. The
running package version is the only release identity; commit SHAs are not part of the update contract.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/); dates are UTC.

## [Unreleased]

## [1.0.15] - 2026-07-14

### Fixed

- Render selected images at the full editor canvas size after loading instead of leaving a one-pixel black stage.
- Make stale iOS PWA clients prepare a guaranteed network-backed close and reopen, using an exact bundle-version
  handshake so an old cached shell cannot repeatedly return after a successful OTA update.

## [1.0.14] - 2026-07-14

### Fixed

- Prevent supported images from crashing the conversation when the editor canvas opens by registering its crop
  transformer in the production bundle.
- Contain future image-editor render failures inside the attachment flow, offering Send original or Cancel instead
  of replacing the chat with a Reload screen.

## [1.0.13] - 2026-07-14

### Fixed

- Restore authenticated image thumbnails and previews in file history without widening access to unrelated routes.

### Changed

- Simplify file sharing to one clear Share action and place Files above Text Input in a separated mobile utility column.
- Replace the previous image editor with a fast, touch-friendly crop and annotation flow for drawing, arrows, text,
  redaction, rotation, undo, and redo before sending on mobile and desktop.

## [1.0.12] - 2026-07-14

### Fixed

- Keep the terminal and chat immediately available when session file history is interrupted by a server restart;
  recover automatically after reconnect, bound filesystem waits, and contain any remaining error inside the Files
  panel with a safe in-place retry.

## [1.0.11] - 2026-07-14

### Added

- Manage sent and received files from a responsive file center on desktop and mobile, with durable history,
  unread status, previews, downloads, sharing, removal, undo, and explicit permanent deletion.
- Upload multiple files through the picker, drag and drop, or paste with progress, cancellation, retry, and an
  automatic terminal attachment reference after each successful upload.
- Edit images at full resolution before sending or from received-file copies using crop, rotate, brightness,
  contrast, text, drawing, arrows, shapes, and opaque redaction tools.

## [1.0.10] - 2026-07-14

### Fixed

- Start mobile Backspace hold-repeat even when an Android IME reports the identified Backspace key as a
  composing `keyCode 229` event.

## [1.0.9] - 2026-07-14

### Fixed

- Make mobile Backspace repeat reliably, support persistent and simultaneous Ctrl/Alt locks including
  Alt+Backspace word deletion, and keep non-text terminal controls from opening a hidden on-screen keyboard.

## [1.0.8] - 2026-07-14

### Added

- Open visible HTTP(S) URLs and terminal-native hyperlinks with one click or tap, including URLs wrapped across
  visual lines, while preserving desktop drag selection, mobile long-press selection, and non-link TUI input.

## [1.0.7] - 2026-07-14

### Changed

- Paste clipboard text directly from the terminal selection menus, and expand the mobile key bar's manual text-input
  key across both rows so the remaining terminal keys retain their original columns.

## [1.0.6] - 2026-07-14

### Changed

- Replace the mobile terminal's detached plain-text selection screen with live long-press selection, adjustable
  handles, and an inline Copy/Paste menu; remove the redundant Select buttons while preserving desktop behavior.

## [1.0.5] - 2026-07-13

### Changed

- Publish a no-behavior-change follow-up release to verify the repaired detached OTA helper and the new reconnecting
  progress experience from `v1.0.4` end to end.

## [1.0.4] - 2026-07-13

### Fixed

- Restore OTA installation by packaging the detached updater helper with exactly one executable shebang; detect an
  early helper exit or an unclaimed start automatically instead of leaving clients on `Starting…` forever.
- Make update progress survive PWA reloads and app suspension, reconcile success from both operation status and the
  running version, and discover server-wide updates started by another signed-in device.

### Changed

- Replace the ambiguous update spinner with explicit Prepare, Install, Verify, Switch, and Reconnect steps; keep a
  compact progress banner visible when the detail sheet is hidden and explain reconnecting/slow updates in plain text.

## [1.0.3] - 2026-07-13

### Changed

- Publish a no-behavior-change patch release to verify the stable in-app OTA path from `v1.0.2` end to end.

## [1.0.2] - 2026-07-13

### Fixed

- Keep the outer `npx` native-build allowlist from leaking into the project-scoped managed runtime install,
  where npm 12 rejects command-line script policy in favor of the pinned `allowScripts` package policy.

## [1.0.1] - 2026-07-13

### Fixed

- Preserve the Node.js shebang in the published CLI and run release smoke tests through the actual npm bin,
  restoring `npx roamcode@latest install` and Homebrew execution.

## [1.0.0] - 2026-07-13

### Stable version distribution

- Publish `roamcode`, `@roamcode.ai/server`, and `@roamcode.ai/web` as one exact version through npm trusted
  publishing, then update the permanent Homebrew tap and create the stable GitHub Release last.
- Add permanent installation through `npx roamcode@latest install` and
  `brew install burakgon/roamcode/roamcode && roamcode install`.
- Replace checkout/commit OTA with stable GitHub Release discovery, npm integrity verification, an isolated
  boot smoke, atomic version activation, and one-version rollback.

### First-class Codex support

- Every new-session flow now requires a fresh choice between Claude Code and Codex; the provider is never
  remembered or inferred. Each choice exposes only its provider-native model, reasoning/effort, safety, profile,
  search, and directory controls.
- Codex runs its real TUI through the same tmux/PTY bridge as Claude Code, with provider-labelled session state,
  accounts, usage/rate limits, versions, files, and notifications. Missing or degraded Codex metadata does not
  disable the live terminal or the Claude provider.
- Codex ChatGPT device-code login is available from the PWA. RoamCode never accepts an OpenAI API key and keeps
  login codes, access tokens, and raw metadata frames out of persisted session data and diagnostics.
- Codex conversations persist and resume by an exact validated thread id. Ambiguous identity disables resume;
  RoamCode never guesses with a global `--last` session.
- Existing Claude rows, live tmux sessions, compatibility routes, auth, usage, attachments, and resume behavior
  remain supported across the additive provider migration. OSS/local Codex providers remain deferred.

### Renamed — Remote Coder is now RoamCode

The project, repo (`github.com/burakgon/roamcode`), packages (`@roamcode.ai/*`), CLI (`roamcode`), and app
branding are all renamed. **Existing installs keep working and keep receiving OTA updates** — no action
needed:

- The updater accepts the pre-rename `burakgon/remote-coder` origin (GitHub redirects it permanently).
- An existing `~/.config/remote-coder` data dir (token, service.json, session index) keeps being used;
  legacy `REMOTE_CODER_*` env vars are still honored everywhere (new `ROAMCODE_*` names win when both set).
- The browser migrates `remote-coder.*` localStorage keys at boot — nobody is signed out.
- Live terminal sessions survive: the internal tmux socket keeps its original name on purpose.
- New sessions expose the send-file MCP as `roamcode` (was `remote-coder`) — if you allow-listed
  `mcp__remote-coder__*` tools in Claude settings, you'll be prompted once for the new name.

### Security

- Codex attachment credentials no longer enter the main Codex process as a bearer-token environment value.
  RoamCode now gives Codex only the path to a per-session mode-0600 token file; normal provider teardown removes
  the artifact, and the startup sweep removes stale files left by an interrupted server.
- OTA remote-trust is now an **exact** repo match (was a substring, which accepted look-alike remotes).
- Auth lockout can no longer be used to deny service to the legitimate user — a correct token is always
  accepted; the lockout only throttles wrong guesses.
- Web-Push endpoints are rejected if they point at loopback/private/link-local hosts (SSRF hardening).
- `POST /sessions` validates `model` / `permissionMode`; `TRUST_PROXY` accepts a specific proxy IP/CIDR.

### Fixed

- Older clients and automations may continue omitting `provider` from `POST /sessions`; the server resolves those
  legacy requests to Claude while the current new-session wizard still requires an explicit provider choice.
- Ended Codex sessions now enable **Resume conversation** only for an exact, validated conversation identity.
  Missing, pending, ambiguous, or unsafe identities leave Resume visible but disabled, explain why, and keep
  **Start fresh** available; ended-session copy also names the actual provider.
- The web test suite now actually runs in CI (Vitest 4 had silently dropped the workspace file).
- A `memory-fallback` store no longer kills every live terminal on restart/OTA.
- Token expiry after load returns the client to the login screen instead of retrying forever.
- API requests time out instead of stranding the loading UI; the terminal reconnect rebuilds a rotated
  token and offers a manual "Reconnect now"; low-contrast text raised to WCAG AA.

### Changed / added

- OTA build/install run at low priority (`nice`/`ionice`) to keep a busy host responsive.
- Opt-in idle-session reaper (`SESSION_IDLE_TTL_MS`, default off).
- Boot warnings + `install.sh` preflight when `tmux` is missing; `docs/service` points at `roamcode install`.
