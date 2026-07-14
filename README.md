<div align="center">

<img src="docs/icon.svg" width="96" alt="RoamCode">

# RoamCode

### The real Claude Code or Codex TUI — running on your machine, driven from your phone.

**[roamcode.ai →](https://roamcode.ai)**

A self-hosted app that runs the **actual `claude` or `codex` CLI** and puts its **real terminal UI** in your pocket. Pick Claude Code or Codex for every new session; RoamCode bridges that provider's own TUI from your machine instead of rebuilding it as a chat. What you'd see at your desk, you now see on your phone: the same prompts, permission UI, tools, and agent workflow.

[![Stars](https://img.shields.io/github/stars/burakgon/roamcode?style=flat-square&color=f77a44)](https://github.com/burakgon/roamcode/stargazers)
&nbsp;[![License: MIT](https://img.shields.io/badge/License-MIT-1c1c20?style=flat-square)](LICENSE)
&nbsp;[![Discussions](https://img.shields.io/github/discussions/burakgon/roamcode?style=flat-square&color=1c1c20&label=discuss)](https://github.com/burakgon/roamcode/discussions)
&nbsp;![Platform](https://img.shields.io/badge/macOS%20·%20Linux-1c1c20?style=flat-square)
&nbsp;![CLI auth](https://img.shields.io/badge/auth-your%20existing%20CLI%20login-1c1c20?style=flat-square)
&nbsp;![PWA](https://img.shields.io/badge/installable-PWA-1c1c20?style=flat-square)

<br/>

<img src="docs/media/startup-mobile.png" alt="A fresh Claude Code session opening in the terminal on a phone — the real TUI's welcome screen" width="31%">
&nbsp;
<img src="docs/media/codex-mobile.png" alt="RoamCode on a phone — the real Codex TUI streaming in a terminal, with provider and safety labels" width="31%">
&nbsp;
<img src="docs/media/sessions-mobile.png" alt="The sessions sheet — every session, which one needs you, and your subscription usage" width="31%">

<br/><br/>

**📱 your phone** &nbsp;→&nbsp; 🔒 **your machine** *(RoamCode)* &nbsp;→&nbsp; 🤖 **`claude` or `codex`** *(your login)*

<sub>Self-hosted control plane · your existing CLI login · no RoamCode cloud relay · token-secured · MIT</sub>

<br/><br/>

**Install it in ~60 seconds** — on a machine with Claude Code or Codex installed:

```bash
npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install
# macOS alternative:
brew install burakgon/roamcode/roamcode && roamcode install
```

<sub>Installs the exact stable release as a per-user service and starts it. Prefer a foreground trial? Run <code>npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest</code>.</sub>

</div>

---

## What it is

You run a small server on your dev machine. For each session you explicitly choose **Claude Code or Codex**; RoamCode launches that real CLI inside a persistent terminal and serves a polished, installable app you open from your phone or any browser. The app is a **true terminal** (xterm.js) wired to the provider TUI, not a transcript reimplementation. Authentication remains with the CLI on your host.

That framing is the whole point:

- **Nothing is reimplemented, so nothing is lost.** Permission prompts, multiple-choice questions, subagent panels, slash commands, thinking, diffs — they all just work, because it's the genuine TUI, not a bespoke chat trying to keep up with it.
- **It survives real life.** The session lives in `tmux` on your machine. Lock your phone, lose signal, close the app, switch networks — reconnect and it re-attaches exactly where it was, command still running.
- **It's actually usable by thumb.** A full-screen terminal on a touchscreen is normally miserable; the hard part RoamCode solves is the ergonomics — a Termux-style key bar, sticky Ctrl, two-finger scroll to read back, and long-press selection directly on the live terminal.

It's **host-native** (your machine, your files, your existing Claude/Codex configuration), **secure by default** (a mandatory access token), and **MIT** licensed.

## Why it exists

Anthropic ships first-party remote control and chat bots — but `claude` remote-control can only **resume** a session that was already started *at the machine*, and the third-party chat bots **reinterpret** Claude Code into a messaging UI, so they drift, drop features, and can't answer its prompts. The moment Claude needs a decision, you're stuck until you're back at your desk.

RoamCode closes that gap by refusing to reinterpret anything — it gives you the real terminal, and now applies the same approach to Codex:

|  | `claude remote-control` | Telegram / Discord bots | **RoamCode** |
|---|:---:|:---:|:---:|
| Start a **brand-new** session remotely | resume only | ✗ | **✓** |
| The provider's **real** TUI, nothing reinterpreted | Claude only, resume only | ✗ | **Claude or Codex** |
| Approve/deny tool use · answer questions, as at your desk | — | ✗ | **✓** |
| Survives a dropped connection / closed app *(tmux)* | ✗ | ✗ | **✓** |
| Files **to and from** the agent | ✗ | Telegram only | **✓** |
| Run **several** sessions at once | — | ✗ | **✓** |
| **Split screen** — sessions side by side *(iTerm2-style)* | — | ✗ | **✓** |
| Live status per session — see **which one needs you** | — | ✗ | **✓** |
| Installable app · self-hosted · MIT | — | — | **✓** |

## What you can do

### The real coding-agent TUI, live in your pocket
The app renders the actual `claude` or `codex` fullscreen TUI in a real terminal — colors, box-drawing, permission UI, tool output, and all. Claude keeps Claude-native controls; Codex gets its own model/reasoning, sandbox, approval, profile, search, add-directory, and dangerous-bypass controls. RoamCode does not translate one provider's safety model into the other's.

<div align="center">
<img src="docs/media/desktop.png" alt="RoamCode on desktop — the sessions rail beside a live claude terminal session" width="900">
</div>

### Split screen on desktop
On a desktop browser the workspace splits **iTerm2-style**: open panes from the header or by **dragging a session from the rail** onto a pane's edge, drag a pane **by its title bar** to rearrange (or flip a side-by-side split into a stacked one), resize with the dividers, and the layout **persists** across reloads. Closing a pane never kills the session — it keeps running in `tmux`, right there in the rail.

<div align="center">
<img src="docs/media/split-desktop.png" alt="Desktop split screen — three live Claude sessions side by side in resizable, draggable panes, iTerm2-style" width="900">
</div>

### Made for thumbs, not just mirrored
A TUI on a phone is only good if you can actually drive it. RoamCode adds a **Termux-style key bar** (Esc, Tab, arrows, Home/End, PgUp/PgDn, `/ - | ~`, `^C`, `^D`, Paste) with a **sticky Ctrl** that turns your next keystroke into a control chord. **Two fingers scroll** back through the transcript; **long-press selects on the live terminal**, with adjustable handles and a direct Copy/Paste menu. Each provider's dangerous mode is a clearly marked, **per-session** choice.

<div align="center">
<img src="docs/media/keybar-mobile.png" alt="The mobile key bar with sticky Ctrl, plus live terminal selection handles and Copy/Paste actions" width="31%">
<img src="docs/media/newsession-mobile.png" alt="The git-aware directory picker for starting a brand-new session remotely" width="31%">
<img src="docs/media/login-mobile.png" alt="The token login screen" width="31%">
</div>

### Never lose your place
Every session is a `tmux` session on your machine, and the terminal WebSocket **re-attaches** on reconnect. A locked phone, a subway tunnel, a killed app, a Wi-Fi→cellular hop — none of it interrupts the work. Come back and the selected provider is still there, still running, right where you left it.

### Files, both ways
Upload images and files into a session, browse and download host files, and ask the coding agent to **send you a file or image** — it lands in the session's **Files** panel to view full-size or download. Each session reports explicitly if its attachment integration is degraded.

<div align="center">
<img src="docs/media/files-mobile.png" alt="The Files panel — images and files exchanged with Claude, viewable full-size and downloadable" width="31%">
<img src="docs/media/ota-mobile.png" alt="The in-app update banner and changelog panel with a one-tap Update now" width="31%">
</div>

### Many sessions, and you know which one needs you
A live **sessions rail** (a bottom sheet on mobile, a permanent pane on desktop) labels every session Claude or Codex and shows **working**, a loud coral **needs you** when the provider blocks on input, or a calm **idle** after a turn. Activity comes from provider-native terminal signals with a tested pane fallback. Settings keeps each provider's account, version, and usage/rate-limit data separate.

### Built to live on your phone
An installable **PWA** (Add to Home Screen, no app store) and **Web Push** when a session finishes or needs a decision — so you can walk away and get pulled back only when it matters.

### Make it yours
An **OLED true-black theme**, provider-native saved option defaults, and **per-session renames** make the app yours. Provider choice itself is deliberately never saved or inferred: every new-session flow asks Claude Code or Codex again.

### Updates itself — one tap, no terminal
When a stable version lands on GitHub Releases, the app shows an **update notice** with its SemVer and grouped release notes. Tap **Update now** and RoamCode downloads the exact npm version, verifies it against the release manifest, boot-smokes it, atomically activates it, and reconnects. The previous version remains available for rollback; commits and `origin/main` are never update identities.

## Quickstart

**Permanent service (recommended)** — one command installs the current stable release and starts a
per-user LaunchAgent (macOS) or `systemd --user` unit (Linux):

```bash
npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install
```

The curl bootstrap calls that same published installer: `curl -fsSL https://roamcode.ai/install | bash`.
On macOS the permanent Homebrew tap is another supported channel:

```bash
brew install burakgon/roamcode/roamcode
roamcode install
```

`brew upgrade roamcode` updates the foreground CLI; rerun `roamcode install` to move the managed service to that exact version. `npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest` runs a foreground trial; append `install` to create or update the permanent service. The narrow allowlist lets npm 12 build RoamCode's SQLite and PTY native modules.

> **Windows?** RoamCode runs great under WSL2 — see **[docs/windows-wsl.md](docs/windows-wsl.md)**.

### Source/development install

You need:

- **Node ≥ 24.** Check with `node --version`.
- **[pnpm](https://pnpm.io/).** The easiest way is `corepack enable` (ships with Node) — then `pnpm` just works in the repo. Otherwise `npm i -g pnpm`.
- **[tmux](https://github.com/tmux/tmux).** Each session runs inside tmux so it survives disconnects. `brew install tmux` (macOS) / `apt install tmux` (Debian/Ubuntu). Use a UTF-8 locale so both TUIs' glyphs render.
- **At least one supported coding-agent CLI:** [Claude Code](https://docs.claude.com/claude-code) and/or [Codex](https://developers.openai.com/codex/cli). Authenticate the CLI on this host. Claude keeps its in-app code flow; Codex ChatGPT device-code login can be started and completed from the PWA. RoamCode never asks for an OpenAI API key. A missing provider does not disable the other.
- A working **native build of `better-sqlite3`.** `pnpm install` builds it; if your toolchain can't, the server still boots but **falls back to a non-durable in-memory store** (sessions vanish on every restart). It logs a loud warning and `/diag` reports `storeMode: "memory-fallback"` — see [Troubleshooting](docs/troubleshooting.md).

```bash
git clone https://github.com/burakgon/roamcode && cd roamcode
corepack enable                 # makes `pnpm` available (or: npm i -g pnpm)
pnpm install && pnpm build
node packages/cli/dist/index.js
```

It generates an access token and prints a ready-to-use link:

```
RoamCode is running.
  Access token generated and stored in the data dir. Open this link to connect:
    http://127.0.0.1:4280/?token=<token>
```

Open it on the same machine — then read **[From your phone](#from-your-phone)** to reach it remotely.

Source checkouts remain useful for contributors. Production OTA migrates an existing checkout-backed service into the managed version layout on its first v1 update; after that, updates never mutate the checkout.

## From your phone

The server binds to `127.0.0.1` and **should not be exposed directly**. Put an HTTPS tunnel in front of it (the installable app and Web Push both require HTTPS) — your machine stays the host, and the token is still enforced on every request through the tunnel.

```bash
# with the server running on 127.0.0.1:4280
cloudflared tunnel --url http://127.0.0.1:4280
```

Open the printed `https://…` link on your phone, paste the token (or use the `?token=…` link), **Add to Home Screen**, and turn on notifications. *(Tailscale Serve works too: `tailscale serve --bg http://127.0.0.1:4280`.)*

> ⚠️ **`cloudflared tunnel --url` gives you an *ephemeral* `trycloudflare.com` URL that changes every run.** That's fine for a quick try, but an **installed PWA is bound to the origin you installed it from** — when the URL changes, your home-screen app points at a dead origin and push deep-links break. For real day-to-day use, set up a **named/stable tunnel** (a fixed hostname) — Cloudflare Named Tunnel, or Tailscale Serve, whose `…ts.net` hostname is stable — and set `ROAMCODE_PUBLIC_URL` to that origin so push notifications click through to the right place.

<details>
<summary><b>Run it as a background service · flags · environment variables</b></summary>

<br/>

`roamcode install` (or the `npx` install command above) installs the exact CLI version into `~/.local/share/roamcode/releases/<version>`, points a stable launcher at it, writes a per-user service unit (**macOS** LaunchAgent / **Linux** `systemd --user`), enables it, and starts it. It runs as **you**, not root, with a PATH that can resolve either supported CLI.

The common variables (full reference, every var verified against the code → [docs/configuration.md](docs/configuration.md)):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4280` | Listen port (`0` = OS-chosen). |
| `BIND_ADDRESS` | `127.0.0.1` | Keep loopback; use a tunnel for remote. |
| `ACCESS_TOKEN` | _(generated)_ | Override the token (used verbatim, never written to disk). |
| `NO_TOKEN` | _(unset)_ | `1` = tokenless dev mode. **Loopback binds only** — it refuses to start non-loopback. |
| `FS_ROOT` | `$HOME` (then cwd) | Confine the file picker / fs endpoints to a subtree. **Does not sandbox the agent** (see Security). |
| `MAX_UPLOAD_BYTES` | `26214400` | Upload size cap (25 MiB). |
| `ROAMCODE_DATA_DIR` | `~/.config/roamcode`¹ | SQLite DB, token, VAPID keys, **logs** (mode 0700). |
| `ROAMCODE_PUBLIC_URL` | _(bind URL)_ | Your user-facing origin (the tunnel URL). **Set this** behind a tunnel: it's the click-target for push notifications and an allowed Origin. |
| `TRUST_PROXY` | _(off)_ | Honor `X-Forwarded-For` behind a reverse proxy, so the per-client lockout/rate-limit key on the real client IP (not the proxy's). Prefer a specific proxy IP/CIDR (e.g. `127.0.0.1`) over `1`/`true`, which trusts every hop and is spoofable. |
| `ROAMCODE_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated extra Origins the CSWSH guard allows (beyond same-origin/loopback/`PUBLIC_URL`). |
| `ROAMCODE_RATE_LIMIT_RPM` | `600` | Sustained requests/minute per client. `0` **disables** the limiter. |
| `ROAMCODE_RATE_LIMIT_BURST` | `120` | Instantaneous burst allowance (token-bucket). |
| `ROAMCODE_MAX_SESSIONS` | `25` | Max concurrent **live** coding-agent sessions; new spawns get `429` at the cap. `0` = unbounded. |
| `CLAUDE_BIN` | `claude` | Path/name of the Claude Code CLI to spawn (must be on the service's PATH). |
| `CODEX_BIN` | `codex` | Path/name of the Codex CLI to spawn (must be on the service's PATH). |
| `ROAMCODE_VAPID_SUBJECT` | `mailto:roamcode@localhost` | `mailto:`/URL contact in the Web Push VAPID claim. |
| `WEB_DIR` | _(bundled)_ | Override the path to the built PWA (`packages/web/dist`). |
| `XDG_CONFIG_HOME` | _(unset)_ | When `ROAMCODE_DATA_DIR` is unset, the data dir is `$XDG_CONFIG_HOME/roamcode`. |
| `ROAMCODE_INSTALL_ROOT` | `~/.local/share/roamcode` | Managed release directories and atomic `current` / `previous` pointers. Usually leave unset. |

¹ `ROAMCODE_DATA_DIR` → else `$XDG_CONFIG_HOME/roamcode` → else `~/.config/roamcode` → else `./.roamcode`.

The **access token never enters provider argv**. Claude's temporary auth/config artifacts are mode `0600`; Codex MCP receives only allow-listed environment-variable names in argv and the values through its process environment. `ANTHROPIC_API_KEY` is stripped from managed Claude processes. RoamCode never accepts or persists an OpenAI API key, though it can report that the Codex CLI is already authenticated by one. The token-rotation grace window is a fixed **60s**. `--help` lists both executable overrides.

### Logs & diagnostics

- **macOS (LaunchAgent):** stdout → `<data-dir>/roamcode.log`, stderr → `<data-dir>/roamcode.err.log` (`<data-dir>` defaults to `~/.config/roamcode`). These are **not rotated** — cap them with the OS log rotator (a `newsyslog.d` entry) or periodically truncate. `tail -f ~/.config/roamcode/roamcode.err.log`.
- **Linux (`systemd --user`):** logs go to **journald** — `journalctl --user -u roamcode -f` (journald already size-bounds itself; tune with `journalctl --user --vacuum-size=50M`).
- **`GET /diag`** (token-gated, like every API route) returns build/store/Node/update health plus a `providers` object. Claude and Codex report terminal availability independently; Codex also distinguishes its auxiliary metadata capability and last redacted integration error. Metadata may degrade while a live TUI remains usable. `GET /health` is the only unauthenticated route and returns `{ ok: true }` only.

</details>

## Security

RoamCode is, by design, **remote code execution on your own machine** — that's the whole point. Treat the token like an SSH key.

- **Single mandatory token** on every request and WebSocket — constant-time check, per-client lockout. It is a **single shared secret** (not per-user/per-device): anyone with it has full access. It **refuses to start** on a non-loopback bind without one. Rotate it anytime with `POST /token/rotate` (the old token is honored for a 60s grace, then rejected; the app re-stores the new one).
- **HTTPS for anything remote** — a plain public port leaks the token. Always tunnel.
- **Provider-native safety stays visible.** Claude permission mode and Codex sandbox/approval policy are persisted and labelled per session. Both dangerous bypass modes require an explicit per-session confirmation and remain visibly marked.
- **⚠️ RoamCode does NOT sandbox the agent.** Claude Code or Codex runs as **your host user**. Codex's own sandbox and either provider's approval UI are useful controls, not a separate RoamCode security boundary. `FS_ROOT` scopes only RoamCode's file APIs; it does not confine the CLI process. Run this only on a machine you'd hand someone with your shell.
- **Defense-in-depth controls** (all on by default, tunable — see the env table): a **cross-origin (CSWSH) guard** rejects a present, cross-origin, non-allow-listed `Origin` (`ROAMCODE_ALLOWED_ORIGINS`, `ROAMCODE_PUBLIC_URL`); a per-client **rate limiter** (`ROAMCODE_RATE_LIMIT_RPM`/`_BURST`, `0` disables); a **concurrency cap** on live sessions (`ROAMCODE_MAX_SESSIONS`); and `TRUST_PROXY` so those keys on the real client IP behind a proxy.

**Stuck or unsure?** See **[docs/troubleshooting.md](docs/troubleshooting.md)** for the common first-run and runtime failures.

## Community & Contributing

- 💬 **Questions, ideas, "show your setup"** → [GitHub Discussions](https://github.com/burakgon/roamcode/discussions)
- 🐛 **Bugs / feature requests** → [Issues](https://github.com/burakgon/roamcode/issues/new/choose)
- 🔒 **Security** → [SECURITY.md](SECURITY.md)
- 🤝 **Contributing** → [CONTRIBUTING.md](CONTRIBUTING.md)

If it's useful to you, a ⭐ helps other coding-agent users find it.

Full-TypeScript pnpm monorepo — `server` · `web` · `cli`. The server bridges a terminal WebSocket to the selected provider TUI running under `tmux` (via `node-pty`); the web app is an installable React PWA built on `xterm.js`.

```bash
pnpm install && pnpm build
pnpm typecheck && pnpm lint && pnpm test
```

Released under the **[MIT](LICENSE)** license.

---

<p align="center">
  <a href="https://www.star-history.com/#burakgon/roamcode&Date">
    <img src="https://api.star-history.com/svg?repos=burakgon/roamcode&type=Date" alt="Star History Chart" width="600">
  </a>
  <br>
  <sub>If RoamCode saves you a trip back to the desk, <a href="https://github.com/burakgon/roamcode">a star</a> helps others find it.</sub>
</p>
