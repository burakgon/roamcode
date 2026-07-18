# Changelog

RoamCode ships stable SemVer releases through npm, GitHub Releases, the Homebrew tap, and in-app OTA. The
running package version is the only release identity; commit SHAs are not part of the update contract.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/); dates are UTC.

## [Unreleased]

## [1.3.0] - 2026-07-18

### Added

- Add the Node-first **Agents** inventory, runtime authentication controls, and exact Node/runtime Session launch.
- Add manual coding **Automations** pinned to one Node, runtime, working directory, and provider option set; every Run
  opens a durable real terminal Session and keeps immutable history after its definition is deleted.
- Add the same-origin RoamCode account surface with Personal and Organization contexts, Node inventory, People &
  Access administration, access requests, and separate CLI and managed-browser device revocation.
- Add managed browser enrollment from an authorized Organization Node into the existing end-to-end encrypted
  terminal, plus browser-assisted `roamcode cloud login` and account-bound Node connection commands.

### Changed

- Make **Sessions**, **Automations**, and **Agents** the complete primary navigation on desktop and mobile while
  retaining legacy workspace and attention contracts for compatible integrations.
- Keep self-hosted Nodes personally owned until an explicit managed-cloud transfer, persist managed ownership across
  configuration loss, and make signed cloud Node grants a read-only projection of organization People & Access.
- Serve account, public legal/security documents, and the installable terminal from one canonical web origin while
  retaining a safe legacy app-host redirect and the unchanged open-source self-hosted path.
- Keep hosted account creation and managed-terminal handoff behind a versioned, fail-closed control-plane capability
  document while preserving sign-in, sign-out, and account recovery against older control planes.

### Fixed

- Keep Node Admin access scoped to one Node, replace role downgrades atomically, revoke device and relay terminal
  streams when local or cloud read access disappears, and reauthorize input-lease renewal after permission changes.
- Make automation invocation identity durable across the HTTP response crash window, reconcile live Sessions after a
  restart, reject unavailable runtime authentication before spawning, and wait for a real provider composer before
  submitting a task.
- Prevent one-use relay bootstrap credentials from entering idempotency replay storage and preserve failed Run and
  started-Session recovery details without creating duplicate side effects.
- Keep managed browser activation fail-closed across confirmation, broker promotion, authorization refresh, response
  loss, restart, role or grant revocation, and explicit browser-device cleanup without storing raw relay credentials.
- Preserve Codex thread identity across macOS `/tmp` path aliases and detect a ready composer that rendered before the
  first terminal subscriber, so fast launches and Automation Runs do not stall or duplicate work.

## [1.2.0] - 2026-07-16

### Added

- Provision, inspect, update, rotate, suspend, and delete hosted relay accounts through secure `roamcode cloud`
  operator commands that read the root capability from a private file, generate account capabilities locally, send
  only hashes to the relay, commit the raw capability atomically to a mode-0600 output file, and verify a retained
  pending capability before recovery after an ambiguous result.
- Add a no-public-IP GCP and Cloudflare Tunnel deployment profile with immutable container digests, least-privilege
  Secret Manager access, an isolated network, bounded containers and logs, verified SQLite backups, and a documented
  daily persistent-disk snapshot policy.
- Show live cloud-relay health in **Settings → Devices**, distinguish setup, connecting, online, reconnecting, and
  offline states, and prevent remote-pairing actions that cannot succeed.
- Create the first remote browser enrollment directly from the host with `roamcode cloud pair`, using a five-minute,
  one-use terminal QR/app link and expiry-bounded broker cleanup instead of requiring an already-paired local browser.
- Repair or change a managed host's trusted PWA origin with `roamcode cloud configure --app-url` without deleting and
  re-provisioning its relay route.
- Add external HTTPS and public WebSocket acceptance checks that verify permanent redirects, security/cache policy,
  real bidirectional blind-frame forwarding, transient-route cleanup, regional uptime checks, and alert-policy drift.

### Changed

- Keep a private pending capability recoverable when an account create or rotation response is ambiguous, including
  server failures, while removing staged credentials after definitive rejection and preserving the legacy
  server-generated credential API for compatibility.
- Compensate an ambiguous host-credential rotation back to the previous remote hash before restoring local state; if
  neither mutation can be confirmed, retain the new private local credential instead of silently stranding the host
  on a credential that may already have been revoked.
- Harden the relay with a global upgraded-socket ceiling, reconnect-resistant host/device rate windows, ping
  accounting, bounded WebSocket envelopes, disabled compression, strict browser-origin checks, and automatic pruning
  of expired bootstrap devices.
- Keep current and previous root capabilities in owner-only mounted files, and enforce HTTPS redirects, HSTS, CSP,
  anti-framing, no-sniff, referrer, permission, and cache policy at both the direct host and cloud edge.
- Run the cloud edge image as a dedicated non-root UID by default, and bound both portable relay containers with
  read-only roots, process and memory ceilings, no-new-privileges, and rotated local logs.

### Fixed

- Keep **Settings → Devices** selected during smooth scrolling and pairing reflow, bring a newly created QR into view,
  and preserve 44-pixel mobile category targets without horizontal overflow.
- Make **Cancel** revoke unused direct and cloud pairing links instead of only hiding their QR codes; failed QR
  rendering also cleans up the unadvertised capability, while a relay cancellation remains retryable until broker
  revocation is confirmed and never silently revokes a device that won the enrollment race.
- Resume an unfinished one-use relay pairing after an accidental same-tab reload without restoring the secret URL
  fragment or keeping the temporary capability beyond its original expiry; cancelled, expired, and explicitly
  removed relay devices now delete their browser identity, while startup hygiene preserves every active or in-flight
  key and removes abandoned pairing identities.
- Repair and verify the packaged macOS PTY helper during the startup capability probe, so an unrepairable install is
  reported before a terminal session starts instead of failing after the user creates it.
- Rotate the relay routing capability inside the encrypted device claim so a copied one-use pairing URL loses broker
  access at its original expiry, while retaining a short overlap for safe retry after an ambiguous final response.
- Return a real `404` for missing cloud PWA assets and other file-like paths instead of serving the HTML shell with
  a successful response or an immutable cache policy; extensionless client routes still receive the SPA fallback.
- Purge every owned route when an account is deleted, reconcile routes whose owner is deleted or missing after a
  restart, close live routes from their authenticated in-memory owner even if durable cleanup fails, and keep a
  recovery-only credential check available to suspended accounts without restoring route access.
- Preserve a verifiable private credential after an ambiguous account or host rotation instead of reporting success,
  discarding the only usable key, or leaving recovery stuck indefinitely.
- Preserve the generated route identity and host capability in a private recovery configuration when both initial
  cloud provisioning and compensating cleanup are ambiguous, while never deleting a route after a definitive
  provisioning rejection.
- Surface the relay's bounded, control-character-safe pairing failure in the CLI after cleanup, so quota and service
  errors remain actionable without echoing arbitrary proxy output or capabilities.
- Open secret-bearing host configuration and relay identity files through verified non-following descriptors, fsync
  their parent directories after durable mutations, verify visible local state after a late durability error so a
  remote rollback cannot strand an already-committed host credential, require both hosted SQLite databases in
  backups, and bound restore readiness probes so a wedged container cannot stall the recovery drill indefinitely.
- Persist the host access token with atomic, fsynced replacement; reject links, oversized or corrupt token files
  instead of silently rotating credentials; repair legacy permissions through the verified file descriptor; and make
  concurrent first starts converge on one durable token without printing an unused secret.
- Accept bracketed IPv6 loopback origins consistently for direct hosts, peer registration and one-use pairing, and
  local relay app URLs instead of incorrectly requiring HTTPS for `http://[::1]` development endpoints.
- Check that the configured cloud host is online before issuing a one-use CLI pairing enrollment, so an offline host
  cannot consume a five-minute link that it is unable to complete.
- Reset saturated relay transports when a pong or peer-close notice cannot be queued, so slow connections cannot
  retain ghost devices or an out-of-sync host channel map.

## [1.1.0] - 2026-07-16

### Added

- Pair browsers with a five-minute, one-use CLI link and terminal QR so the durable host key never enters the device
  URL or browser storage.
- Give every paired browser an independently revocable key, with last-seen inventory, QR/link creation, and immediate
  terminal, API, and push revocation under **Settings → Devices**.
- Add a mobile-and-desktop command center with multiple direct hosts, cross-host search, durable attention items, and
  workspace/worktree controls while keeping existing sessions immediately usable.
- Expose versioned CLI, OpenAPI, event, workspace, agent, attention, lease, automation, and audit contracts so people
  and coding agents can operate the same guarded control surface.
- Install integrity-pinned provider adapters and plugins with explicit permission review, bounded execution, audit,
  enable/disable, rollback, uninstall, and three reference plugin packages.
- Stream encrypted relay uploads, downloads, image previews, and terminal files with bounded backpressure,
  cancellation, byte-integrity checks, and the same authorization/audit path as direct access.
- Ship a minimal non-root ARM64/amd64 blind-relay image and static cloud PWA edge with mounted secrets, durable
  readiness, protected aggregate metrics, explicit origin/rate limits, restart persistence, and self-hosted operations
  guidance, published as immutable SBOM/provenance-attested release digests.
- Add secure `roamcode cloud connect/status/rotate/disconnect` commands and an operator-ready account control plane
  with isolated, quota-bound routes; managed hosting remains pre-production pending independent security review.
- Coordinate agents across explicitly scoped peer hosts through stable read, wait, send, start, focus, discovery, and
  single-writer lease APIs, with local and remote RBAC/policy enforcement and no provider-credential delegation.
- Connect or recover a peer with a five-minute, one-use pairing link. The durable remote device credential is claimed
  server-side, host identity and origin are pinned, new peers begin workspace-denied, and failed setup cleans up the
  newly claimed device.
- Add organization roles, service identities, device bindings, presence, policy, integrity-verifiable audit export,
  and privacy-bounded fleet inventory across the PWA, CLI, API, direct, and relay authorization paths.

### Changed

- Keep the complete single-host product local-first and account-free while making direct, self-hosted relay, and
  explicitly configured peer-host connections visible through one responsive host switcher.
- Make destructive settings actions use accessible inline confirmation, enlarge touch targets, preserve narrow-screen
  layouts, and lazy-load optional command-center surfaces to keep the installable PWA fast.

### Fixed

- Keep the relay WebSocket client as an installed runtime dependency so clean npm packages boot instead of failing on
  an ESM dynamic import before the server can become healthy.
- Start exactly one blind-relay listener in the minimal cloud image so container replacement reliably reopens the port
  instead of hiding a duplicate bundled entrypoint behind an apparently healthy first process.
- Recover a managed server that still accepts TCP but stops answering HTTP by checking its per-process health from a
  separate watchdog, then restarting only the RoamCode process while preserving detached tmux sessions.
- Keep the standalone watchdog entry out of the normal server bundle's startup path so packaged installs reach
  `/health` instead of exiting before the server opens its port.
- Exit into launchd/systemd recovery after an uncaught fatal error instead of keeping a potentially corrupted process
  bound to the port, and refuse accidental development servers on the installed service's implicit `4280` port.

## [1.0.23] - 2026-07-15

### Changed

- Seed each new-session wizard from the provider, model, reasoning, permissions, and additional directories used by
  the last successful launch, storing those choices on the server instead of in browser storage.
- Remove the duplicate **New sessions** defaults section from Settings so launch choices live in one place: the
  new-session wizard.

## [1.0.22] - 2026-07-15

### Fixed

- Keep both keyboard-toolbar rows visible on iOS when the software keyboard is closed without restoring page drag.

## [1.0.21] - 2026-07-15

### Fixed

- Prevent the keyboard toolbar's bottom safe-area strip from dragging the full-screen app shell.

## [1.0.20] - 2026-07-15

### Fixed

- Keep the full-screen shell fixed during one-finger terminal gestures and disable browser pinch zoom while
  preserving intentional scrolling inside panels and the terminal's two-finger scrollback gesture.

### Changed

- Repair a macOS-blocked, OpenAI-signed Homebrew Codex executable atomically in its original location, remove the
  obsolete RoamCode-managed copy once the source is healthy, and roll back automatically if validation fails.

## [1.0.19] - 2026-07-15

### Fixed

- Detect a Codex CLI whose launch macOS blocks indefinitely and recover it with a private verified copy of the
  official OpenAI-signed binary, so Codex becomes available again on affected Macs without touching the original
  installation.
- Skip Codex metadata startup entirely when the Codex executable itself is unavailable, instead of probing a
  binary that cannot run.

## [1.0.18] - 2026-07-15

### Fixed

- Keep native mobile Backspace hold-repeat alive after the first deletion, without double-deleting on synthesized
  key events, and preserve sticky Ctrl/Alt modifiers across every repeated delete.

## [1.0.17] - 2026-07-15

### Changed

- Replace the oversized image text-entry box with a compact inline editor that grows with its content and matches the
  final annotation size on mobile and desktop.
- Remove the image crop aspect-ratio preset row so cropping stays focused on direct freeform manipulation.

## [1.0.16] - 2026-07-14

### Changed

- Rebuild image cropping with compact scale-independent handles, generous invisible touch targets, live composition
  guides, common aspect-ratio presets, and exact output dimensions across mobile and desktop.
- Make text, drawing, arrow, and redaction annotations directly selectable, movable, restylable, resizable, editable,
  and removable with contextual controls, gesture-safe zooming, keyboard nudging, and reliable undo and redo.

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
