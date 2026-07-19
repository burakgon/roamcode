# Configuration reference

RoamCode is a standalone service. Configuration belongs to the Node process and its direct clients; there is no
hosted account, remote fleet, or shared reachability service to configure.

CLI flags map to the common server variables: `--port` sets `PORT`, `--bind` sets `BIND_ADDRESS`, and `--no-token`
sets `NO_TOKEN=1`. `roamcode pair --url <origin>` selects the public origin for that one pairing link.

Integer settings fall back to their defaults when absent or unparseable. A parseable value outside its documented
range is a boot error.

## Core server settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4280` | TCP listen port. `0` asks the OS for a free port. Range: `0–65535`. |
| `BIND_ADDRESS` | `127.0.0.1` | Listen address. A non-loopback bind without `ACCESS_TOKEN` is rejected. |
| `ACCESS_TOKEN` | generated | Explicit host recovery credential. It wins over the persisted token and is not written to disk. |
| `NO_TOKEN` | unset | `1` enables credential-free loopback development. It is rejected on non-loopback binds. |
| `FS_ROOT` | `$HOME` | Root boundary for RoamCode's file picker, file APIs, extensions, and worktree operations. It does not sandbox the provider CLI. |
| `MAX_UPLOAD_BYTES` | `26214400` | Maximum upload size in bytes. Minimum `1`. |
| `SESSION_IDLE_TTL_MS` | `0` | Kill detached idle terminal processes after this duration. `0` keeps Sessions alive indefinitely. |
| `TRUST_PROXY` | off | Trusted reverse-proxy IP/CIDR or comma-list. Prefer a specific hop such as `127.0.0.1`; `1`/`true` trusts every hop. |

Without `ACCESS_TOKEN`, RoamCode persists a generated host credential in `<dataDir>/token` with mode 0600 and exposes
only five-minute one-use pairing capabilities to browsers. A direct device credential can be revoked independently.

## RoamCode settings

The matching legacy `REMOTE_CODER_*` name remains accepted for renamed settings so existing local installations can
upgrade without rewriting service configuration. `ROAMCODE_*` wins when both are present.

| Variable | Default | Effect |
| --- | --- | --- |
| `ROAMCODE_DATA_DIR` | `~/.config/roamcode` | Mode-0700 operational data directory for SQLite state, credentials, VAPID keys, service metadata, and logs. |
| `ROAMCODE_PUBLIC_URL` | unset | Stable user-facing origin used by origin checks, pairing defaults, and notification links. |
| `ROAMCODE_ALLOWED_ORIGINS` | empty | Comma-separated additional browser Origins beyond same-origin, loopback, and `ROAMCODE_PUBLIC_URL`. |
| `ROAMCODE_RATE_LIMIT_RPM` | `600` | Sustained requests per minute per client. `0` disables the rate limiter. |
| `ROAMCODE_RATE_LIMIT_BURST` | `120` | Token-bucket burst allowance. Minimum `1`. |
| `ROAMCODE_MAX_SESSIONS` | `25` | Concurrent live terminal cap. `0` disables the cap. |
| `ROAMCODE_AUTOMATION_CONCURRENCY` | `2` | Maximum local Automation Runs launched concurrently. Invalid or non-positive values fall back to `2`. |
| `ROAMCODE_HOST_NAME` | platform label | Human-readable label for this standalone Node. |
| `ROAMCODE_VAPID_SUBJECT` | `mailto:roamcode@localhost` | `mailto:` or `https:` VAPID subject for Web Push. Invalid values disable push without stopping the server. |

Data-directory resolution is `ROAMCODE_DATA_DIR`, legacy `REMOTE_CODER_DATA_DIR`,
`$XDG_CONFIG_HOME/roamcode`, `~/.config/roamcode`, then `./.roamcode`. At default locations an existing pre-rename
directory is reused so OTA does not lose Sessions or device state.

## Provider and runtime settings

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | Claude Code executable available to the service process. |
| `CODEX_BIN` | `codex` | Codex executable available to the service process. |
| `CODEX_HOME` | Codex default | Optional Codex configuration home used for provider metadata and profile resolution. |
| `WEB_DIR` | bundled web build | Override the static PWA directory. A missing path leaves the API running without static files. |
| `RC_TMUX_SOCKET` | `remote-coder` | Dedicated tmux socket. Give isolated development/test instances a different value. The legacy default is retained so existing Sessions survive upgrades. |
| `XDG_CONFIG_HOME` | unset | Base directory used when `ROAMCODE_DATA_DIR` is absent. |

`ANTHROPIC_API_KEY` is stripped from RoamCode-managed Claude processes. RoamCode does not collect OpenAI API keys;
Codex authentication belongs to the Codex CLI. Attachment helpers receive only bounded, per-session connection data,
and credentials never enter provider command-line arguments.

## Installed-service internals

These names are owned by the standalone launcher and watchdog. Normal operators should not set them.

| Variable | Default | Effect |
| --- | --- | --- |
| `ROAMCODE_INSTALL_ROOT` | `~/.local/share/roamcode` | Stable release directories and atomic `current`/`previous` pointers. |
| `ROAMCODE_MANAGED_EXEC` | launcher sets `1` | Marks the installed standalone launcher and enables the liveness watchdog. Here “managed” means locally managed installation, not an external service. |
| `ROAMCODE_DISABLE_WATCHDOG` | unset | `1` disables the out-of-process watchdog for isolated smoke tests or emergency diagnosis. |

`ROAMCODE_WATCHDOG_PARENT_PID`, `ROAMCODE_WATCHDOG_PORT`, and `ROAMCODE_WATCHDOG_INSTANCE_ID` are generated for the
watchdog child and are not operator configuration.

## Direct API and peer federation

These variables are read by `roamcode api`. Command flags take precedence.

| Variable | Default | Effect |
| --- | --- | --- |
| `ROAMCODE_API_URL` | `http://127.0.0.1:4280` | Coordinating standalone Node origin. Credentials, query, and fragment are rejected. |
| `ROAMCODE_API_TOKEN` | required | Device or host bearer credential sent in the Authorization header. |
| `ROAMCODE_PEER_PAIRING_FILE` | unset | Preferred owned, non-symlink, mode-0600 file containing a five-minute one-use remote pairing link. |
| `ROAMCODE_PEER_CREDENTIAL_FILE` | unset | Existing automation only: private file containing an independently revocable remote device/service credential. |

Peer pairing and a pre-existing peer credential are mutually exclusive. Direct federation requires stable HTTPS,
except loopback HTTP in isolated development. See [Peer federation](peer-federation.md).

## Reverse-proxy baseline

Keep RoamCode bound to loopback and terminate HTTPS at a proxy you operate. Set `ROAMCODE_PUBLIC_URL` to the exact
browser origin and `TRUST_PROXY` to the proxy hop only when forwarded client addresses are required. Preserve WebSocket
upgrade headers and do not strip the Authorization header. Never publish the plain HTTP port directly.
