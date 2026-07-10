# Changelog

RoamCode ships continuously via in-app OTA (the running build is identified by its git short SHA, shown
in `/version` and the app footer). This file records notable changes at a human-readable grain; for the exact
commit a build is on, see its SHA.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/); dates are UTC.

## [Unreleased]

### Renamed — Remote Coder is now RoamCode

The project, repo (`github.com/burakgon/roamcode`), packages (`@roamcode/*`), CLI (`roamcode`), and app
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

- OTA remote-trust is now an **exact** repo match (was a substring, which accepted look-alike remotes).
- Auth lockout can no longer be used to deny service to the legitimate user — a correct token is always
  accepted; the lockout only throttles wrong guesses.
- Web-Push endpoints are rejected if they point at loopback/private/link-local hosts (SSRF hardening).
- `POST /sessions` validates `model` / `permissionMode`; `TRUST_PROXY` accepts a specific proxy IP/CIDR.

### Fixed

- The web test suite now actually runs in CI (Vitest 4 had silently dropped the workspace file).
- A `memory-fallback` store no longer kills every live terminal on restart/OTA.
- Token expiry after load returns the client to the login screen instead of retrying forever.
- API requests time out instead of stranding the loading UI; the terminal reconnect rebuilds a rotated
  token and offers a manual "Reconnect now"; low-contrast text raised to WCAG AA.

### Changed / added

- OTA build/install run at low priority (`nice`/`ionice`) to keep a busy host responsive.
- Opt-in idle-session reaper (`SESSION_IDLE_TTL_MS`, default off).
- Boot warnings + `install.sh` preflight when `tmux` is missing; `docs/service` points at `roamcode install`.
