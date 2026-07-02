# Troubleshooting

Remote Coder is self-hosted, so when something breaks it's on your machine — but it's designed to tell you *what*. This page covers the common first-run and runtime failures, in rough order of how often they bite.

The fastest first step is almost always **`GET /diag`** (token-gated):

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:4280/diag
```

It returns a JSON snapshot: the running build sha and whether it drifted from the checkout, `storeMode` (`sqlite` vs the non-durable `memory-fallback`), `claude` availability + version, the Node version, and the last update state. `GET /health` (unauthenticated) returns only `{ ok: true }` — use it to confirm the server is *up* at all.

---

## `claude` not found / not authenticated

**Symptom:** starting a session fails. The app surfaces a clear message instead of a generic error:

- **`503` — "Claude Code CLI not found on PATH."** The server couldn't even spawn `claude`.
  - Confirm it's installed and on **the server's** PATH: `which claude`.
  - If it works in your login shell but not under the service, the service has a **minimal PATH**. Reinstall the service unit (`node packages/cli/dist/index.js install`) — the generated unit sets a PATH that includes node's dir, Homebrew, and pnpm's global bin — or set `CLAUDE_BIN=/full/path/to/claude`.
- **`502` — "`claude` is installed but not authenticated (or failed to start)."** It spawned but never completed the handshake — almost always because it isn't logged in.
  - Run `claude` **once in a terminal on the host** and complete the login. There is **no remote login**.
  - On macOS the service must run as a real **login** user (it's a LaunchAgent, not a LaunchDaemon) for the subscription auth to resolve.

You'll also see a loud **startup warning** in the logs at boot if `claude --version` can't run, and `/diag` reports `"claude": { "available": false }`.

---

## Sessions vanish after a restart (better-sqlite3 didn't build)

**Symptom:** every restart (including an OTA update) starts with an empty session list; `/diag` shows `"storeMode": "memory-fallback"`, and the boot logs carry a loud `⚠ better-sqlite3 failed to load` warning.

The session/idempotency stores are SQLite-backed. When the native `better-sqlite3` module can't load, they silently fall back to a **non-durable in-memory** store — nothing is persisted across restarts.

**Fix — rebuild the native module:**

```bash
pnpm -C packages/server rebuild better-sqlite3
# or reinstall allowing native builds:
pnpm install && pnpm approve-builds better-sqlite3
```

Then restart the server and re-check `/diag` (`storeMode` should be `"sqlite"`). This usually means a missing C/C++ toolchain — install your platform's build tools (Xcode CLT on macOS, `build-essential` + `python3` on Debian/Ubuntu).

---

## Update failed / stuck

The in-app updater pulls, installs, builds, **boot-smokes the new build**, and only then restarts. A failed build leaves the running server untouched, and a build that boots unhealthy is **rolled back** to the previous commit.

- **Check the state:** `GET /update/status` → `{ state, phase, error? }`. `state: "failed"` carries the `error`.
- **Read the log:** `<data-dir>/update.log` (default `~/.config/remote-coder/update.log`) has the step-by-step output, including the captured pre-update commit and any rollback.
- **"an update is already in progress":** a prior run is still going, or a wedged flag. The updater self-heals a stale `starting`/`failed` flag on the next attempt; if it's truly stuck, restart the service and retry.
- **"working tree is dirty" / local changes:** the updater refuses to `git pull` over uncommitted changes (it would lose them). Commit or stash them, or `git reset --hard` if you don't want them, then retry.
- **Not updatable at all** (`/version` reports `updatable: false`): the server isn't running from a git checkout, or `git`/`pnpm` aren't on the **service's** PATH — reinstall the service unit so its PATH is correct.

---

## Behind a reverse proxy / tunnel

If you front the server with Caddy/Cloudflare/nginx or a tunnel:

- **Set `TRUST_PROXY=1`** so `request.ip` is the real client IP (from `X-Forwarded-For`). Without it, the per-client auth-lockout and rate-limiter collapse onto the proxy's single IP.
- **Set `REMOTE_CODER_PUBLIC_URL`** to your user-facing origin (e.g. `https://code.example.com`). It's the click-target baked into push notifications **and** an allow-listed `Origin`. Without it, push taps may open an unreachable origin.
- **`403 forbidden origin`:** the cross-origin (CSWSH) guard rejected a present, cross-origin, non-allow-listed `Origin`. Add the origin to `REMOTE_CODER_ALLOWED_ORIGINS` (comma-separated) or set `REMOTE_CODER_PUBLIC_URL` to it. The guard never rejects same-origin / loopback / the public URL, so the genuine app is always allowed.
- **`429 rate limited`:** you're past `REMOTE_CODER_RATE_LIMIT_RPM`/`_BURST`. Raise them, or set `REMOTE_CODER_RATE_LIMIT_RPM=0` to disable the limiter. (Confirm `TRUST_PROXY` first — a shared proxy IP makes everyone share one bucket.)
- **WebSocket won't connect:** the proxy must forward the `Upgrade`/`Connection` headers. The token reaches the WS via `?token=` (a browser can't set an `Authorization` header on a WS upgrade).

### Ephemeral tunnel URL breaks the installed app

`cloudflared tunnel --url …` gives a **new** `trycloudflare.com` hostname every run. An installed PWA is bound to the origin it was installed from, so a changing URL leaves your home-screen app pointing at a dead origin and breaks push deep-links. For real use, set up a **named/stable tunnel** (a fixed hostname) and point `REMOTE_CODER_PUBLIC_URL` at it. Tailscale Serve (`…ts.net`) is stable too.

---

## Where are my logs?

| Platform | Where | View |
|---|---|---|
| **macOS** (LaunchAgent) | `<data-dir>/remote-coder.log` (stdout), `<data-dir>/remote-coder.err.log` (stderr) | `tail -f ~/.config/remote-coder/remote-coder.err.log` |
| **Linux** (`systemd --user`) | **journald** | `journalctl --user -u remote-coder -f` |
| **OTA updates** (both) | `<data-dir>/update.log` | `tail -f ~/.config/remote-coder/update.log` |

`<data-dir>` defaults to `~/.config/remote-coder` (override with `REMOTE_CODER_DATA_DIR`).

**Log rotation:** the macOS LaunchAgent log files are **not rotated** — they grow unbounded. Cap them with the OS tools:

- **macOS** — add a `newsyslog.d` rule, e.g. create `/etc/newsyslog.d/remote-coder.conf` (one line, tab/space separated):

  ```
  # logfilename                                            mode count size  when  flags
  /Users/<you>/.config/remote-coder/remote-coder.err.log   644  5     5120  *     J
  /Users/<you>/.config/remote-coder/remote-coder.log       644  5     5120  *     J
  ```

  (`size` is in KB — 5120 ≈ 5 MB, keep 5 gzip'd backups.) Or just truncate periodically: `: > ~/.config/remote-coder/remote-coder.err.log`.
- **Linux** — journald already bounds itself; tune the cap with `journalctl --user --vacuum-size=50M` or `SystemMaxUse=` in `journald.conf`.

---

## How to rotate the token

```bash
curl -X POST -H "Authorization: Bearer <current-token>" http://127.0.0.1:4280/token/rotate
# → { "token": "<new-token>" }
```

The new token is persisted to the `0600` token file and swapped into the live server immediately; the **old token is honored for a 60s grace** (so in-flight requests don't all 401 at once) then rejected. The web app re-stores the new token from the response — on other devices, re-open with the new `?token=…` link. (Rotation is unavailable in `NO_TOKEN` loopback dev mode — there's no token to rotate, so it returns `409`.)

If you suspect the token leaked (it was in a URL that hit a proxy log, say), rotate it.

## Data directory, backups & uninstall

Everything Remote Coder persists lives in one directory — `~/.config/remote-coder` (override with
`REMOTE_CODER_DATA_DIR`), created `0700`:

| File | What it is | If you lose it |
|---|---|---|
| `token` (`0600`) | your access token | a new one is generated on next start (re-open the printed link) |
| `vapid.json` (`0600`) | Web-Push keypair | **every push subscription is invalidated** — re-enable notifications on each device |
| `sessions.db` | terminal session index | running `tmux` sessions still exist; the list is rebuilt on reattach |
| `push.db` | push subscriptions | devices must re-subscribe |

**Backup:** copy the whole directory (it's small). The only piece that's costly to lose is `vapid.json`
(losing it forces every device to re-subscribe to notifications).

**Uninstall:** `node packages/cli/dist/index.js uninstall` prints how to remove the service. To also remove
your data (token, subscriptions, session index) delete the data dir — **this deletes your token + history**:

```bash
rm -rf ~/.config/remote-coder
```
