# Security Policy

RoamCode is, by design, **remote code execution on your own machine** — a token-guarded bridge that runs the real Claude Code or Codex CLI as your user. So security reports matter a lot. Thank you for helping.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use **GitHub's private vulnerability reporting**: the repo's **Security** tab → **Report a vulnerability**. (If that's unavailable to you, open a minimal issue saying only "security report — please open a private channel," with no details.)

Please include: what you found, how to reproduce it, the impact, and the affected stable version (`/version` → `runningVersion`). I'll acknowledge as quickly as I can and keep you posted on the fix.

## What's in scope

The interesting surface is everything reachable **before** the token check, and anything that lets a request do more than the token is meant to allow:

- Auth bypass (any route or the WebSocket upgrade reachable without a valid token), token leakage, the cross-origin/CSWSH guard, the rate limiter / lockout, path traversal in the file endpoints (`/fs/*`, `/images/*`), the OTA updater, or a crafted frame that escalates beyond the permission gate.

## Known + accepted properties (by design — not vulnerabilities)

These are inherent to what the tool *is*; they're documented in the README's Security section:

- **RoamCode does not sandbox the agent.** Claude Code or Codex runs as your host user. Codex's provider-native sandbox and both providers' approval controls can reduce risk, but they are not a separate RoamCode security boundary. `FS_ROOT` only scopes RoamCode's own file endpoints, not what either CLI can read/write.
- **A single shared token** grants full access (it's not per-user). Treat it like an SSH key; rotate via `POST /token/rotate`. The token must be kept off untrusted channels.
- **You must put HTTPS in front of it** for any remote use; a plain public port leaks the token.
- **Terminal mode is a raw host shell, on by default.** A session runs the selected provider's real TUI in a tmux+PTY and streams it to the browser over a token-gated WebSocket — i.e. an interactive shell on your machine. It rides the same token + origin/CSWSH + rate-limit gate as every other route and does **not** narrow the trust boundary: a token holder can choose provider-native safety settings, including an explicit dangerous mode. It auto-disables when `tmux`/`node-pty` are unavailable.
- **Provider metadata is auxiliary.** Codex account/model/rate-limit and exact-identity discovery use a bounded app-server client. Protocol failure is reported as degraded; it must not expose raw frames, credentials, login codes, or stop an already-running TUI. Exact Codex resume stays disabled when identity is missing or ambiguous rather than falling back to a global “last session.”
- **RoamCode never collects provider API keys.** Claude managed processes strip `ANTHROPIC_API_KEY`; Codex may already be authenticated by its own supported methods, but PWA-managed login is ChatGPT device code only. Attachment plumbing never puts the RoamCode bearer token in provider argv. Claude receives it through its mode-0600 MCP configuration artifact. For Codex, RoamCode removes inherited `RC_TOKEN`, writes a bounded per-session mode-0600 token file under the mode-0700 data directory, and gives the main Codex process only the `RC_TOKEN_FILE` path; the attachment MCP subprocess reads that file with owner, regular-file, permission, and size checks. The path is registered before writing, normal provider cleanup removes it, and startup removes stale artifacts left after interrupted cleanup.
- **Mode 0600 is not a same-user sandbox.** It protects the attachment credential from other host users, accidental argv exposure, and ordinary environment inheritance, but a process already running as the RoamCode host user can explicitly read files that user can read. This includes a provider tool deliberately directed to a known token-file path. RoamCode already grants that provider the host user's authority; a least-privilege, session-scoped attachment credential remains deferred hardening rather than a claimed boundary here.

## Supported versions

Only the latest stable SemVer release is supported. Please update through the app, npm, or Homebrew before reporting, in case it is already fixed. Drafts, prereleases, and arbitrary commits are never installed by OTA.
