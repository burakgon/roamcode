<div align="center">

<img src="docs/icon.svg" width="88" alt="RoamCode">

# RoamCode

### Self-hosted mission control for Claude Code and Codex.

Run the real coding-agent TUI on your own machine. Keep Sessions alive and step in from any browser without replacing
the CLI you already trust.

**[Website](https://roamcode.ai)** · **[Get started](docs/getting-started.md)** · **[Documentation](docs/README.md)** ·
**[Discussions](https://github.com/burakgon/roamcode/discussions)**

[![CI](https://img.shields.io/github/actions/workflow/status/burakgon/roamcode/ci.yml?branch=main&style=flat-square&label=checks)](https://github.com/burakgon/roamcode/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/roamcode?style=flat-square&color=f77a44)](https://www.npmjs.com/package/roamcode)
[![GitHub release](https://img.shields.io/github/v/release/burakgon/roamcode?style=flat-square&color=1c1c20)](https://github.com/burakgon/roamcode/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-1c1c20?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/macOS%20%7C%20Linux-1c1c20?style=flat-square)

</div>

<div align="center">
  <img src="docs/media/desktop.png" alt="RoamCode Sessions on desktop with the real coding-agent terminal" width="100%">
</div>

## Start in three steps

RoamCode installs as a per-user service. It defaults to `127.0.0.1`, keeps its own data locally, and prints a
five-minute, one-use pairing link when installation finishes.

### 1. Install on the machine that runs your agents

macOS with Homebrew (recommended; installs Node.js and tmux dependencies):

```bash
brew install burakgon/roamcode/roamcode && roamcode install
```

macOS or Linux with Node.js 24+ and tmux already installed:

```bash
curl -fsSL https://roamcode.ai/install | bash
```

Prefer to inspect the bootstrap first? Read [`scripts/install.sh`](scripts/install.sh), then run the published CLI
directly:

```bash
npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install
```

### 2. Open the pairing link

The installer verifies that the service is healthy, then prints a QR code and one-use link. Open it in a browser on
the same machine. For a phone or another computer, first create a private or HTTPS route you control, then run:

```bash
roamcode pair --url https://your-roamcode.example
```

### 3. Open a terminal

Pick a working directory and choose **Open terminal**. RoamCode starts an ordinary login shell inside `tmux`; run
`claude`, `codex`, or any other command yourself. When a supported coding agent becomes the foreground process,
RoamCode detects it and adds its identity and status to the Session without changing the command, shell, or agent.

> A Session only needs a shell. Install and authenticate a provider CLI when you want to run that agent. See the
> complete [getting-started guide](docs/getting-started.md), including Linux prerequisites, remote access, and
> recovery.

## One control loop

RoamCode is not a chat wrapper and it is not a hosted IDE. It is the control layer around the agent processes already
running on your machine.

| Surface | What it owns |
| --- | --- |
| **Sessions** | Persistent terminals with detected agent status, files, split panes, and intervention. |
| **Runtime detection** | Claude Code and Codex identity, activity, and safety metadata discovered from the foreground process. |
| **Node settings** | Provider sign-in, paired devices, notifications, diagnostics, and stable updates without another product area. |

<div align="center">
  <img src="docs/media/split-desktop.png" alt="RoamCode Sessions rail with three persistent split terminal panes" width="100%">
</div>

## The terminal stays the terminal

RoamCode streams the actual terminal through Ghostty Web. You start the provider in the shell, so its permission
prompts, slash commands, diffs, model controls, subagent panels, sandbox settings, approval policies, and native
safety behavior remain intact.

- Sessions persist in `tmux` and reconnect after browser or network changes.
- Desktop supports resizable, draggable, persistent split panes.
- Mobile adds a Termux-style key bar, sticky Ctrl, one-finger scrollback, selection, clipboard, and file exchange.
- “Needs input” status and Web Push take you directly back to the Session that is waiting.
- Stable updates are integrity-pinned, boot-smoked before activation, and retain the previous verified release for
  rollback.

<table>
  <tr>
    <td width="50%"><strong>Step into the live TUI</strong><br><sub>Respond to the exact prompt or permission in place.</sub><br><br><img src="docs/media/terminal-mobile.png" alt="The real coding-agent TUI in RoamCode on a phone" width="100%"></td>
    <td width="50%"><strong>Select, copy, and chord</strong><br><sub>Use selection, clipboard controls, sticky Ctrl, arrows, Esc, and paging.</sub><br><br><img src="docs/media/keybar-mobile.png" alt="Terminal selection, clipboard controls, and the mobile key bar" width="100%"></td>
  </tr>
  <tr>
    <td width="50%"><strong>Move the artifacts</strong><br><sub>Upload inputs and download files produced by the Session.</sub><br><br><img src="docs/media/files-mobile.png" alt="The Session file exchange panel on a phone" width="100%"></td>
    <td width="50%"><strong>Start the next Session</strong><br><sub>Choose a Git-aware working directory without returning to a desk.</sub><br><br><img src="docs/media/newsession-mobile.png" alt="Starting a Session from the Git-aware directory picker" width="100%"></td>
  </tr>
</table>

## Local-first by construction

```text
browser / installed PWA
          │
          │  device credential + network path you choose
          ▼
your RoamCode Node
          ├── persistent tmux shell Sessions
          └── optional installed claude / codex CLIs
```

There is no RoamCode account, managed relay, or hosted control plane. Your repositories, provider credentials,
prompts, terminal output, and execution stay on the Node. Provider CLIs continue to use their normal provider
services. Remote access can use a private network, VPN, SSH forwarding, or an HTTPS reverse proxy you operate.

RoamCode is intentionally remote code execution on your own machine. Treat every paired browser like an SSH key and
never expose the plain HTTP port to the public internet. Read the [security boundary](SECURITY.md) before enabling
remote access.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, pair, launch the first Session, and verify the service. |
| [Terminal Sessions](docs/terminal-sessions.md) | Shell-first lifecycle, foreground agent detection, and optional integrations. |
| [Remote access](docs/remote-access.md) | Connect another device without exposing an unsafe public port. |
| [Configuration](docs/configuration.md) | Environment variables, service behavior, direct API access, and data paths. |
| [Troubleshooting](docs/troubleshooting.md) | Diagnose service, provider, terminal, pairing, and update failures. |
| [Windows through WSL2](docs/windows-wsl.md) | Run the Linux service and reach it safely from Windows. |
| [Release model](docs/releases.md) | Stable SemVer, npm, Homebrew, and OTA guarantees. |

The additive product API is published by every Node at `GET /api/v1/openapi.json`.

## Development

```bash
git clone https://github.com/burakgon/roamcode.git
cd roamcode
corepack enable
pnpm install
pnpm build
```

Use an isolated `ROAMCODE_DATA_DIR`, tmux socket, and `PORT=0` for development or tests. Do not point a development
process at an installed service's data directory or port. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete
workflow and quality bar.

## Community

- Ask questions and show what you are building in [Discussions](https://github.com/burakgon/roamcode/discussions).
- Report reproducible bugs with the [issue templates](https://github.com/burakgon/roamcode/issues/new/choose).
- Propose focused improvements through pull requests after reading [CONTRIBUTING.md](CONTRIBUTING.md).
- Report vulnerabilities privately through GitHub; never open a public security issue. See [SECURITY.md](SECURITY.md).

RoamCode is MIT licensed. See [LICENSE](LICENSE).
