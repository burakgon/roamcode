# remote-coder

**Start and operate Claude Code sessions on your own machine — fully remotely, from your phone or any browser.**

`remote-coder` is a self-hosted server + installable PWA. An always-on daemon runs on your dev machine, drives the real `claude` CLI as a subprocess (using your Claude **subscription** — no API key, no Agent SDK), and gives you a mobile-and-desktop UI with full parity to operating Claude Code in a rich chat client: streaming output, images, file upload/download, **Claude sending files & images straight to your chat** (ask it to "send me that screenshot/report" — it appears inline), interactive permission + question answering, effort/model switching, a `--dangerously-skip-permissions` toggle, a first-class directory picker, multi-session management, and **Web Push** when a session needs you.

Everything is automatic — `pnpm install && pnpm build` and run; the send-files capability (a built-in MCP `send_image`/`send_file` tool, the same mechanism Anthropic's Telegram plugin uses) is wired into every session with no extra setup or config.

**The wedge:** Anthropic's `claude remote-control` only lets you *resume* sessions already started **at the machine** — you can't create a new chat remotely, and the chat channels can't answer terminal permission prompts. `remote-coder` lets you **spin up a brand-new session from scratch, remotely**, and answer every interactive prompt from your phone. Self-hosted, MIT, secure-by-default (mandatory token).

<p align="center">
  <img src="docs/design/2026-06-23-pwa-app-mobile.png" alt="remote-coder on mobile" height="420">
  &nbsp;&nbsp;
  <img src="docs/design/2026-06-23-pwa-app-desktop.png" alt="remote-coder on desktop" height="420">
</p>

## Quickstart (about 60 seconds)

Requires Node ≥ 20, [pnpm](https://pnpm.io/), and a machine already logged into `claude` (run `claude` once locally to authenticate).

```bash
git clone <this repo> && cd remote-coder
pnpm install
pnpm build
node packages/cli/dist/index.js
```

On first run it generates an access token, stores it in the data dir (`0600`), and prints a ready-to-use direct link:

```
remote-coder is running.
  Open: http://127.0.0.1:4280
  Access token generated and stored in the data dir. Open this link to connect:
    http://127.0.0.1:4280/?token=<long-random-token>

  For remote access put this behind an HTTPS tunnel (see the README).
```

Open that URL on the same machine, or read on to reach it from your phone. (Once published: `npx remote-coder`.)

Useful flags (`node packages/cli/dist/index.js --help` for the full list):

- `--port <n>` — listen port (default `4280`; `0` = pick a free port). Sets `PORT`.
- `--bind <addr>` — bind address (default `127.0.0.1`). Sets `BIND_ADDRESS`. Use `0.0.0.0` **only** behind a secure tunnel.
- `--no-token` — loopback dev only: run without an access token. Sets `NO_TOKEN=1`. Never for public binds.

## Run it as a background service (starts at login)

```bash
node packages/cli/dist/index.js install
```

This writes a per-user service unit and prints the exact command to load it. It runs as **you** — driving your real `claude`, files, and `~/.claude` — and is **not** a root/system daemon. No secret is embedded in the unit; only your data dir is referenced, and the service reads the token from there at runtime.

- **macOS** — a launchd **LaunchAgent** at `~/Library/LaunchAgents/com.remote-coder.plist`. Start/stop:
  ```bash
  launchctl load -w ~/Library/LaunchAgents/com.remote-coder.plist    # start now + at login
  launchctl unload -w ~/Library/LaunchAgents/com.remote-coder.plist  # stop
  ```
- **Linux** — a `systemd --user` unit at `~/.config/systemd/user/remote-coder.service`. Start/stop:
  ```bash
  systemctl --user daemon-reload
  systemctl --user enable --now remote-coder   # start now + at login
  systemctl --user disable --now remote-coder  # stop
  loginctl enable-linger "$USER"               # keep it running without an active login session
  ```

Uninstall (prints the removal commands): `node packages/cli/dist/index.js uninstall`.

## Connect remotely from your phone (HTTPS required)

`remote-coder` binds to `127.0.0.1` by default. **Do not** expose the port directly. Web Push and the installable PWA both require a **secure context (HTTPS)** — `localhost`/loopback is treated as secure for same-machine dev, but any remote origin must be HTTPS. So use a tunnel that gives you an HTTPS URL while the server stays on your host.

### Cloudflare Tunnel (recommended)

With the server running on `127.0.0.1:4280`, in a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:4280
```

`cloudflared` prints an `https://<random>.trycloudflare.com` URL. On your phone:

1. Open that HTTPS URL.
2. Enter the access token (or open `http://127.0.0.1:4280/?token=<token>`-style with the HTTPS host to skip the prompt).
3. "Add to Home Screen" to install the PWA.
4. Enable notifications in Settings — Web Push works because the origin is HTTPS.

For a stable hostname instead of a throwaway one, set up a [named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) pointing at `http://127.0.0.1:4280`.

### Tailscale

Join your phone + host to your tailnet, then reach `http://<host-tailscale-name>:4280` over the private WireGuard network. For Web Push you still need HTTPS, so use **Tailscale Serve/Funnel** to get an HTTPS hostname:

```bash
tailscale serve --bg http://127.0.0.1:4280
```

In both cases the server keeps running on your machine; the tunnel just provides a secure entry point. The access token is still required on every request and WebSocket.

## Security & threat model

By design, `remote-coder` is **remote code execution on your host** — that is the feature. Treat it accordingly:

- **Mandatory access token.** Generated on first run (32 bytes of CSPRNG entropy, base64url), required on every HTTP request **and** WebSocket. The token is verified in **constant time** (`crypto.timingSafeEqual`), with a **per-client lockout** after repeated failures (default 10 failures → 60 s lock) and generic, non-revealing `401`s. If you bind to a non-loopback address with no token, the server **refuses to start**.
- **Where the secret lives.** The data dir is `$REMOTE_CODER_DATA_DIR` → `$XDG_CONFIG_HOME/remote-coder` → `~/.config/remote-coder`, created mode **0700**; the token file and VAPID keys are written mode **0600**. The token is printed **once**, embedded in the direct link, then read from disk on later runs.
- **Treat the token like an SSH key.** Anyone with the token + URL can drive *your* `claude` with *your* permissions and *your* files. Don't paste it into chat logs, screenshots, or shared terminals.
- **HTTPS for anything non-local.** A public port without TLS leaks the token in transit. Use a tunnel (above). `localhost`/loopback is the only place plain HTTP is acceptable.
- **Remote permission gate.** Tool use still prompts for approval — you approve/deny **from your phone**, the same way you would in the terminal. `--dangerously-skip-permissions` is per-session, **off by default**, and surfaced as dangerous (it disables that gate — real, unattended RCE).
- **Restrict the file picker (optional).** Set `FS_ROOT=/path` to confine the directory picker + file endpoints to a subtree (defaults to `$HOME`). This narrows the blast radius of the browse/upload/download endpoints; it does **not** sandbox the `claude` subprocess itself.
- **Behind a reverse proxy** set `TRUST_PROXY=1` so the per-client lockout keys on the real client IP (`X-Forwarded-For`) instead of collapsing to the proxy's single IP.
- **Treat the host as semi-disposable.** It runs your real shell tools as you. The `claude` CLI itself refuses to run as root, but that is a backstop, not a sandbox.

## Why not Docker by default?

`remote-coder` is **host-native on purpose**: it drives your real `claude` binary, your real project files, and your real `~/.claude` **subscription** credentials. Containerizing it would isolate it from exactly those things — a container has no access to your host `claude`, your subscription auth, or your working tree — which **breaks the core use-case** (operating *your* machine's sessions). So there is no default Docker image or compose stack.

**Advanced (not isolation, not recommended):** if you insist on a container, it must run **non-isolated** — `--network host` plus bind-mounts of your home, `~/.claude`, and the data dir — which removes most of Docker's security benefit and is effectively equivalent to running on the host. This is documented only for completeness; it is not the supported path.

## How it compares

| | Anthropic Remote Control | Chat channels (Telegram/Discord) | **remote-coder** |
|---|---|---|---|
| Start a NEW session remotely | No (resume only, started at the machine) | No | **Yes** (first-class directory picker) |
| Answer terminal permission prompts remotely | n/a | No | **Yes** |
| Self-host / MIT | No | varies | **Yes** |
| Installable responsive PWA | — | — | **Yes** |
| Images + file up/down | partial | partial | **Yes** |
| Claude sends YOU files / images (inline) | No | Telegram-only | **Yes** (built-in MCP `send_image`/`send_file`) |
| Web Push when a session needs you | — | n/a | **Yes** |

## Notifications (Web Push)

Enable notifications from the app's **Settings** to get a push when a session finishes or needs your input (a permission prompt or a question). Web Push requires a **secure context**, so it works on `localhost` for same-machine dev and over any HTTPS tunnel — not over plain-HTTP remote origins. The VAPID keypair is generated and persisted in the data dir on first run; set `VAPID_SUBJECT` to a `mailto:`/`https:` contact if you want to override the default.

## Receiving files & images from Claude

Just ask: *"save that chart to a file and send it to me"*, *"send me the screenshot"*, *"send me the build log"*. Claude calls a built-in MCP tool (`send_image` / `send_file`) and the file lands **in your chat** — images preview inline, other files become a download. This is the same mechanism the official Anthropic Telegram plugin uses, and it needs **no setup**: the MCP server (`dist/mcp-send.js`) is built and wired into every session automatically. Files must be inside `FS_ROOT` (default `$HOME`); delivery flows over the same token-gated, fsRoot-validated path as the file picker. In the default permission mode Claude asks before sending (you approve from your phone); a `--dangerously-skip-permissions` session sends with no prompt.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4280` | Listen port (`0` = OS-chosen). |
| `BIND_ADDRESS` | `127.0.0.1` | Bind address. Keep loopback; use a tunnel for remote. |
| `ACCESS_TOKEN` | _(generated)_ | Override the generated/persisted token (used verbatim, never written to disk). |
| `NO_TOKEN` | _(unset)_ | `1` = loopback dev only: run tokenless. Never for public binds. |
| `FS_ROOT` | `$HOME` | Confine the file picker / fs endpoints to a subtree. |
| `MAX_UPLOAD_BYTES` | `26214400` | Upload size cap (25 MiB). |
| `REMOTE_CODER_DATA_DIR` | `~/.config/remote-coder` | SQLite DBs, token, VAPID keys (mode 0700). |
| `WEB_DIR` | _(auto: `packages/web/dist`)_ | Override the built-PWA directory served at `/`. |
| `VAPID_SUBJECT` | `mailto:remote-coder@localhost` | VAPID contact for Web Push (a `mailto:`/`https:` URL). |
| `TRUST_PROXY` | `false` | Honor `X-Forwarded-For` behind a reverse proxy (`1`/`true`). |

## Architecture (at a glance)

- **`packages/server`** — Fastify server: REST + per-session WebSocket + `/push`, the global token auth gate, the `claude` subprocess session manager, SQLite stores (sessions, idempotency, push subscriptions), and serving the built PWA at `/`.
- **`packages/web`** — the React PWA (chat, permission/question answering, file picker, settings, service worker + Web Push).
- **`packages/cli`** — the `remote-coder` binary (serve + `install`/`uninstall`).

See `docs/superpowers/specs/` and `docs/superpowers/plans/` for the full design.

## License

[MIT](LICENSE).
