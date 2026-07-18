# Configuration reference

Every environment variable RoamCode reads, with its default and effect — **verified against the code**
(the source file for each row is linked). The short table in the [README](../README.md) covers the
common ones; this page is the complete list.

Flags on the `roamcode` CLI map onto the first three core vars: `--port` → `PORT`, `--bind` →
`BIND_ADDRESS`, `--no-token` → `NO_TOKEN=1`. `roamcode pair --url <origin>` overrides
`ROAMCODE_PUBLIC_URL` only for the one-time link it prints
([`packages/cli/src/index.ts`](../packages/cli/src/index.ts)).

`roamcode cloud login/logout/whoami` manages the user's control-plane session through browser-assisted device
authorization. Access and rotating refresh credentials use macOS Keychain when available, with an atomic mode-0600
file fallback. The standard hosted sequence is `roamcode cloud login` followed by
`roamcode cloud connect --label <name>`. Managed `connect`, `rotate`, and `disconnect` reuse that signed-in session;
they do not require an account-token file. `configure`, `pair`, and `status` manage the trusted app origin, one-use
remote pairing, and route health.

The `account-create/list/update/rotate/recover/delete` actions provide the standalone relay operator lifecycle without
raw HTTP commands. `--account-token-file` and `ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE` remain explicit compatibility paths
for legacy, self-hosted, or operator-managed direct relay provisioning. Account and root capabilities are read only
from owned mode-0600 regular files; no command accepts a raw value as an argument
([`packages/cli/src/cloud-auth.ts`](../packages/cli/src/cloud-auth.ts),
[`packages/cli/src/cloud.ts`](../packages/cli/src/cloud.ts)).

> **Deployment boundary:** this repository defines and tests the CLI side of the account authorization contract, but
> does not ship the customer account service that implements it. The managed default is the separate
> `https://roamcode.ai` control plane and app origin; a self-hosted compatible service can be selected during login
> with `--control-plane-url`. Relay-operator account capabilities remain a separate provisioning path.

`roamcode api peer-add/peer-rotate` preferably reads a five-minute pairing link from
`--peer-pairing-file` or `ROAMCODE_PEER_PAIRING_FILE`. Existing service automation may instead provide a remote origin
plus `--peer-credential-file` / `ROAMCODE_PEER_CREDENTIAL_FILE`. These modes are mutually exclusive; both files must
be owned, non-symlink, mode-0600 regular files. See [Peer federation](peer-federation.md).

> **Integer parsing rule** (applies to `PORT`, `MAX_UPLOAD_BYTES`, `SESSION_IDLE_TTL_MS`, and the
> `ROAMCODE_RATE_LIMIT_*` / `ROAMCODE_MAX_SESSIONS` vars): an **absent or unparseable** value quietly
> falls back to the default, but a parseable value **outside the allowed range is a boot error** —
> the server refuses to start rather than running with a config you didn't intend
> ([`server-config.ts`](../packages/server/src/server-config.ts)).

## Core

| Var                   | Default            | Effect                                                                                                                                                                                                                                                                                                                                              | Source                                                                                                             |
| --------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PORT`                | `4280`             | TCP listen port. `0` = let the OS pick a free port. Range `0–65535`; out of range refuses to start.                                                                                                                                                                                                                                                  | [`server-config.ts`](../packages/server/src/server-config.ts)                                                       |
| `BIND_ADDRESS`        | `127.0.0.1`        | Address to bind. A **non-loopback** bind with no access token **refuses to start** (spec §9) — put a tunnel in front instead of binding wide.                                                                                                                                                                                                        | [`server-config.ts`](../packages/server/src/server-config.ts)                                                       |
| `ACCESS_TOKEN`        | _(generated)_      | Use this host key verbatim instead of the persisted/generated one. Wins over `<dataDir>/token` and is **never written to disk**. Without it, a 32-byte CSPRNG host key is generated and persisted to `<dataDir>/token` (mode 0600); browser onboarding exposes only a short-lived pairing capability, not this key. | [`data-dir.ts`](../packages/server/src/data-dir.ts)                                                                 |
| `NO_TOKEN`            | _(unset)_          | Exactly `1` = tokenless dev mode: no token generated, stored, or required. **Loopback binds only** — combined with a non-loopback `BIND_ADDRESS` the server refuses to start.                                                                                                                                                                        | [`start.ts`](../packages/server/src/start.ts)                                                                       |
| `TRUST_PROXY`         | _(off)_            | Trust `X-Forwarded-*` so lockout/rate-limit keys on the real client IP behind a reverse proxy. **Preferred form: a specific IP/CIDR (comma-list allowed)**, e.g. `127.0.0.1` for a same-host cloudflared/Caddy — trusts only that hop. `1`/`true` trusts **every** hop (spoofable: a client can prepend to XFF). Anything else (`0`, `false`, unset) = off. | [`server-config.ts`](../packages/server/src/server-config.ts)                                                       |
| `FS_ROOT`             | `$HOME` (else cwd) | Root the file picker / fs endpoints (browse, upload, download, mkdir, search) are confined to. **Does not sandbox the spawned coding agent itself** — see the README's Security section.                                                                                                                                                                    | [`server-config.ts`](../packages/server/src/server-config.ts)                                                       |
| `MAX_UPLOAD_BYTES`    | `26214400` (25 MiB) | Upload size cap. Minimum `1`.                                                                                                                                                                                                                                                                                                                        | [`server-config.ts`](../packages/server/src/server-config.ts)                                                       |
| `SESSION_IDLE_TTL_MS` | `0` (disabled)     | Opt-in reaper for detached sessions: kill running terminals with **no attached client** idle longer than this many ms. `0` keeps the default behavior — detached sessions survive indefinitely for later reattach. When enabled, the sweep runs every `min(max(TTL, 30s), 5min)`.                                                                     | [`server-config.ts`](../packages/server/src/server-config.ts) · [`transport.ts`](../packages/server/src/transport.ts) |

## `ROAMCODE_*`

Every variable in this table also accepts its legacy `REMOTE_CODER_*` name (pre-rename installs keep
working across an OTA update without touching their service env); the `ROAMCODE_*` name wins when both
are set ([`server-config.ts`](../packages/server/src/server-config.ts),
[`data-dir.ts`](../packages/server/src/data-dir.ts), [`updater.ts`](../packages/server/src/updater.ts)).

| Var                                              | Default                    | Effect                                                                                                                                                                                                                                                                | Source                                                        |
| ------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ROAMCODE_DATA_DIR`                              | `~/.config/roamcode` ¹     | Host data dir (mode 0700) for session/device/push SQLite DBs, the host key, VAPID keys, `service.json`, per-session MCP/hook files, and service logs.                                                                                                                   | [`data-dir.ts`](../packages/server/src/data-dir.ts)            |
| `ROAMCODE_PUBLIC_URL`                            | _(unset)_                  | Your user-facing origin (the tunnel URL). Allow-listed by the Origin/CSWSH guard and used as the click-target for push notifications. **Set this when serving behind a tunnel.**                                                                                        | [`server-config.ts`](../packages/server/src/server-config.ts)  |
| `ROAMCODE_ALLOWED_ORIGINS`                       | _(empty)_                  | Comma-separated **extra** Origins the CSWSH guard allows, beyond same-origin / loopback / `ROAMCODE_PUBLIC_URL`.                                                                                                                                                        | [`origin-check.ts`](../packages/server/src/origin-check.ts)    |
| `ROAMCODE_RATE_LIMIT_RPM`                        | `600`                      | Sustained requests/minute per client (token bucket). `0` **disables** the limiter entirely.                                                                                                                                                                             | [`server-config.ts`](../packages/server/src/server-config.ts)  |
| `ROAMCODE_RATE_LIMIT_BURST`                      | `120`                      | Instantaneous burst allowance. Minimum `1` (a 0-size bucket would block everything).                                                                                                                                                                                    | [`server-config.ts`](../packages/server/src/server-config.ts)  |
| `ROAMCODE_MAX_SESSIONS`                          | `25`                       | Max concurrent **live** coding-agent sessions (Claude Code or Codex); `POST /sessions` gets `429` at the cap. `0` = unbounded.                                                                                                                                          | [`server-config.ts`](../packages/server/src/server-config.ts)  |
| `ROAMCODE_VAPID_SUBJECT`                         | `mailto:roamcode@localhost` | `mailto:`/`https:` contact in the Web Push VAPID claim (web-push requires one). An invalid subject **disables push** with a boot warning rather than killing the server.                                                                                                | [`start.ts`](../packages/server/src/start.ts)                  |

¹ Full resolution order: `ROAMCODE_DATA_DIR` → `REMOTE_CODER_DATA_DIR` → `$XDG_CONFIG_HOME/roamcode` →
`~/.config/roamcode` → `./.roamcode` — and at each default location, an **existing** pre-rename
`remote-coder` directory is preferred over creating a fresh `roamcode` one, so upgraded installs keep
their token, `service.json`, and session index ([`data-dir.ts`](../packages/server/src/data-dir.ts)).

## Advanced / internal

| Var               | Default                       | Effect                                                                                                                                                                                                                                                                | Source                                                                    |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CLAUDE_BIN`      | `claude`                      | Path/name of the Claude Code CLI to spawn (must resolve on the **service's** PATH — the installed unit prepends the node dir and common tool locations for exactly this reason).                                                                                        | [`config.ts`](../packages/server/src/config.ts)                            |
| `CODEX_BIN`       | `codex`                       | Path/name of the Codex CLI to spawn (must resolve on the **service's** PATH). Independently overridable from `CLAUDE_BIN`.                                                                                                                                              | [`server-config.ts`](../packages/server/src/server-config.ts)              |
| `WEB_DIR`         | _(bundled)_                   | Override the directory the built PWA is served from (default: the repo's `packages/web/dist`). A path that doesn't exist just disables static serving — the API still runs.                                                                                             | [`start.ts`](../packages/server/src/start.ts)                              |
| `CODEX_HOME`      | _(Codex default)_             | Passed through to the Codex CLI/app-server as its config home (`$CODEX_HOME/config.toml` and profile layers). RoamCode reads it only to locate Codex metadata; unset means Codex's own default (`~/.codex`).                                                              | [`start.ts`](../packages/server/src/start.ts) · [`codex-provider.ts`](../packages/server/src/providers/codex-provider.ts) |
| `RC_TMUX_SOCKET`  | `remote-coder`                | The dedicated tmux server socket that isolates RoamCode's sessions from your own tmux. Override so a **second** instance (tests, a verification server) gets its own socket and can't reap the primary's sessions. The default keeps the pre-rename name **on purpose** — live sessions exist on that socket and an OTA restart must find them again. | [`terminal-process.ts`](../packages/server/src/terminal-process.ts)        |
| `XDG_CONFIG_HOME` | _(unset)_                     | When `ROAMCODE_DATA_DIR` is unset, the data dir resolves under `$XDG_CONFIG_HOME/roamcode` (see the resolution order above).                                                                                                                                            | [`data-dir.ts`](../packages/server/src/data-dir.ts)                        |
| `ROAMCODE_INSTALL_ROOT` | `~/.local/share/roamcode` | Managed release directories, the atomic `current`/`previous` pointers, and the stable launcher. Usually leave this unset. | [`managed-runtime.ts`](../packages/server/src/managed-runtime.ts) |
| `ROAMCODE_MANAGED_EXEC` | _(launcher sets `1`)_ | Marks the stable managed launcher. It enables the separate HTTP-liveness watchdog and bypasses the foreground default-port collision guard. Do not set this for a source/dev server. | [`managed-runtime.ts`](../packages/server/src/managed-runtime.ts) · [`health-watchdog.ts`](../packages/server/src/health-watchdog.ts) |
| `ROAMCODE_DISABLE_WATCHDOG` | _(unset)_ | Emergency/isolated-smoke escape hatch for a managed process. `1` disables the out-of-process liveness watchdog; normal installs should leave it unset. | [`health-watchdog.ts`](../packages/server/src/health-watchdog.ts) |

## Peer federation CLI

These variables are read by `roamcode api`, not by the server service. Command flags take precedence.

| Var | Default | Effect |
| --- | --- | --- |
| `ROAMCODE_API_URL` | `http://127.0.0.1:4280` | Local coordinating host origin used by `roamcode api`. Credentials, query, and fragment are rejected. |
| `ROAMCODE_API_TOKEN` | _(required)_ | Device or host bearer credential sent only in the Authorization header. |
| `ROAMCODE_PEER_PAIRING_FILE` | _(unset)_ | Preferred owned, non-symlink, mode-0600 file containing a five-minute one-use remote pairing link. |
| `ROAMCODE_PEER_CREDENTIAL_FILE` | _(unset)_ | Existing automation only: private file containing an independently revocable remote device/service credential. |

## Optional cloud host

| Var | Default | Effect |
| --- | --- | --- |
| `ROAMCODE_CLOUD_CONTROL_PLANE_URL` | `https://roamcode.ai` | Account service origin used by `roamcode cloud login`; `--control-plane-url` overrides it. Non-loopback origins must use HTTPS. The approved origin is persisted with the session so tokens cannot later be sent to a different origin. |
| `ROAMCODE_CLOUD_HOST_CONFIG_FILE` | `<dataDir>/cloud-host.json` | Optional managed-host configuration. When present, it must be an owned, non-symlink, mode-0600 regular file containing the organization/host ids, fixed HTTPS control-plane origin, `rch_…` host capability, refresh intervals, and an expiry-bounded pinned Ed25519 authorization keyset. V1 is the backward-compatible raw `Ed25519` profile; V2 is the hosted `Ed25519-SHA256` profile that signs an exact 32-byte, domain-separated canonical-envelope digest. Config, keyset, envelope version, algorithm, and domains must match exactly. Its presence starts privacy-minimal heartbeat plus signed authorization refresh; its absence preserves self-host behavior exactly. Missing the full signing-key overlap fails closed and requires authenticated host re-provisioning plus atomic replacement of this file—never manual key edits or trust-on-first-use. This file is always separate from `relay-host.json`. |
| `ROAMCODE_CLOUD_HOST_CREDENTIAL_FILE` | _(unset)_ | Legacy enrollment-only compatibility seam: an owned, non-symlink, mode-0600 file containing the host's `rch_…` capability. It can attest device enrollment when no managed host configuration exists, but does not enable heartbeat or cloud authorization. New provisioning writes the complete `cloud-host.json` instead. |
| `ROAMCODE_CLOUD_URL` | `https://relay.roamcode.ai` | Standalone relay API origin used by the explicit account-token compatibility flow and relay operator commands. `--url` overrides it. Non-loopback origins must use HTTPS. Managed provisioning receives its reviewed relay origin from the signed-in control plane instead. |
| `ROAMCODE_CLOUD_APP_URL` | `https://roamcode.ai` | Trusted app origin written by the explicit standalone relay compatibility flow; `--app-url` overrides it. Managed provisioning receives the canonical app origin from the signed-in control plane. |
| `ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE` | _(unset)_ | Legacy/self-host/operator compatibility only: owned, non-symlink, mode-0600 file containing a standalone relay `rrk_…` account capability. `--account-token-file` overrides it. Normal hosted `connect`, `rotate`, and `disconnect` use the signed-in cloud session. |
| `ROAMCODE_CLOUD_ROOT_TOKEN_FILE` | _(unset)_ | Owned, non-symlink, mode-0600 file containing the relay operator `rrp_…` root capability. `--root-token-file` overrides it for account lifecycle commands. |
| `ROAMCODE_CLOUD_HOST_LABEL` | `RoamCode host` | Privacy-preserving user-visible label for a newly provisioned route; `--label` overrides it. The OS hostname is not uploaded implicitly. |
| `ROAMCODE_RELAY_URL` | _(unset)_ | HTTPS/WSS relay origin or `/v1/connect` URL. With the next two variables, overrides managed `relay-host.json`. |
| `ROAMCODE_RELAY_ROUTE_ID` | _(unset)_ | Opaque route identity. All three core relay variables are required together. |
| `ROAMCODE_RELAY_HOST_CREDENTIAL` | _(unset)_ | Route-specific raw host capability. Prefer the mode-0600 managed file created by `roamcode cloud connect`. |
| `ROAMCODE_RELAY_APP_URL` | _(unset)_ | Static PWA origin used only for one-use remote pairing links. |
| `ROAMCODE_RELAY_HOST_LABEL` | `RoamCode host` | User-visible host label; wins over the legacy/general host-name variables. |

The managed host runtime never accepts an organization id, host id, control-plane URL, callback URL, actor id, key,
or host credential from a browser request. It sends the host capability only to fixed control-plane endpoints, refuses
redirects, bounds response sizes and request time, verifies every authorization snapshot with its pinned Ed25519
keyset and provisioned signature profile, rejects cross-version downgrade responses, and installs a rotated keyset
only after it is cross-signed by a current pin. The latest accepted snapshot is
kept as a replay floor and last-known-good record, but access fails closed as soon as that snapshot expires. Host and
loopback recovery credentials remain available so a control-plane outage cannot lock the owner out of the machine.
Authenticated clients can read `/api/v1/cloud/status` even when a snapshot has expired. That response contains only
coarse sync/expiry state, the last successful sync time, and a stable recovery action; it never includes the host
capability, signing keys, grants, organization/host identifiers, or control-plane origin.

Managed provisioning keeps two credentials independent: the `rch_…` capability in `cloud-host.json` authenticates the
Node to the control plane, while the `rrh_…` capability in `relay-host.json` authenticates only its blind relay route.
The raw relay capability is generated locally and only its domain-separated hash is sent during provisioning. Before
a remote connect or rotation mutation, the CLI persists `cloud-host-operation.json` as an owned, non-symlink,
mode-0600 recovery journal. An interrupted retry reuses the same operation id and credential material; the journal is
removed only after both final configuration files have been durably committed.

## Standalone blind relay

These variables are read only by the separate `roamcode-relay` executable/container. They do not enable cloud access
on a host by themselves; host connector variables are documented in
[`packaging/relay/README.md`](../packaging/relay/README.md).

| Var | Default | Effect |
| --- | --- | --- |
| `ROAMCODE_RELAY_ROOT_TOKEN` | _(required unless file is used)_ | Current root provisioning capability. Prefer the file form in containers. |
| `ROAMCODE_RELAY_ROOT_TOKEN_FILE` | _(unset)_ | Read the root capability from a mounted file. Setting both token forms is a boot error. |
| `ROAMCODE_RELAY_PREVIOUS_ROOT_TOKEN_DIR` | _(unset)_ | Owned mode-0700 directory containing up to three owned private files for a bounded root-capability rotation overlap. Preferred for containers. |
| `ROAMCODE_RELAY_PREVIOUS_ROOT_TOKENS` | _(empty)_ | Legacy comma-separated former root capabilities. Retained for compatibility; file-backed rotation avoids putting capabilities in process environments. |
| `ROAMCODE_RELAY_ACCOUNTS_ENABLED` | `0` (`1` in reference Compose) | Enables durable standalone relay accounts, per-account route ownership, and route/device quotas in a separate SQLite store. |
| `ROAMCODE_RELAY_DATA_DIR` | platform data dir + `/relay` | Durable SQLite route/device database. |
| `ROAMCODE_RELAY_BIND` | `127.0.0.1` | Relay listen address; the reference container binds `0.0.0.0` only inside its private network. |
| `ROAMCODE_RELAY_PORT` | `4281` | Relay listen port (`0` chooses a free port for tests). |
| `ROAMCODE_RELAY_ALLOWED_ORIGINS` | _(empty outside production)_ | Exact comma-separated PWA origins allowed for browser WebSockets. Required in `NODE_ENV=production` unless the explicit reviewed escape hatch is set. |
| `ROAMCODE_RELAY_ALLOW_ANY_ORIGIN` | `0` | `1` permits an empty origin allowlist in production. Use only after explicit security review. |
| `ROAMCODE_RELAY_HANDSHAKE_TIMEOUT_MS` | `5000` | Unauthenticated WebSocket deadline; range 1000–30000. |
| `ROAMCODE_RELAY_IDLE_TIMEOUT_MS` | `120000` | Idle authenticated connection deadline; range 10000–3600000. |
| `ROAMCODE_RELAY_MAX_FRAME_BYTES` | `1500000` | Maximum opaque frame size; range 1024–16777216. |
| `ROAMCODE_RELAY_MAX_QUEUE_BYTES` | `4000000` | Maximum WebSocket buffered queue; range 1024–67108864. |
| `ROAMCODE_RELAY_MAX_TOTAL_CONNECTIONS` | `1024` | Global WebSocket ceiling, including unauthenticated handshakes; range 1–100000. |
| `ROAMCODE_RELAY_MAX_CONNECTIONS_PER_ROUTE` | `64` | Concurrent paired devices per route; range 1–10000. |
| `ROAMCODE_RELAY_MAX_BYTES_PER_MINUTE` | `67108864` | Per host/device identity opaque-byte ceiling; the current window survives reconnects. |
| `ROAMCODE_RELAY_MAX_MESSAGES_PER_MINUTE` | `12000` | Per host/device identity message ceiling, including pings; the current window survives reconnects. |

## Not configurable (by design)

- The **access token never enters provider argv** — per-session MCP/hook helpers read it from a
  provider-owned mode-0600 artifact file, referenced via `RC_TOKEN_FILE` in the child process
  environment ([`provider-artifacts.ts`](../packages/server/src/providers/provider-artifacts.ts),
  [`mcp-send.ts`](../packages/server/src/mcp-send.ts)). Codex MCP config receives only the
  **allow-listed environment-variable names** (`RC_BASE_URL`, `RC_SESSION_ID`, `RC_TOKEN_FILE`) in
  argv; the values travel through the process environment
  ([`codex-provider.ts`](../packages/server/src/providers/codex-provider.ts)).
- `ANTHROPIC_API_KEY` is always **stripped** from managed Claude processes (subscription auth only).
  RoamCode never accepts or persists an OpenAI API key, though `/diag` can report that the Codex CLI
  is already authenticated by one.
- The token-rotation grace window (old token honored briefly after `POST /token/rotate`) is a fixed
  **60 s**.
- `ROAMCODE_WATCHDOG_PARENT_PID`, `ROAMCODE_WATCHDOG_PORT`, and `ROAMCODE_WATCHDOG_INSTANCE_ID` are
  generated in a minimal environment for the watchdog child. They are not inherited from the shell, never contain an
  access credential, and are not operator configuration.
