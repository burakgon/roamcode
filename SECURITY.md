# Security Policy

RoamCode is, by design, **remote code execution on your own machine** — a token-guarded bridge that runs the real `claude` CLI as your user. So security reports matter a lot. Thank you for helping.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use **GitHub's private vulnerability reporting**: the repo's **Security** tab → **Report a vulnerability**. (If that's unavailable to you, open a minimal issue saying only "security report — please open a private channel," with no details.)

Please include: what you found, how to reproduce it, the impact, and the affected version (`/version` → `runningBuild`, or the commit sha). I'll acknowledge as quickly as I can and keep you posted on the fix.

## What's in scope

The interesting surface is everything reachable **before** the token check, and anything that lets a request do more than the token is meant to allow:

- Auth bypass (any route or the WebSocket upgrade reachable without a valid token), token leakage, the cross-origin/CSWSH guard, the rate limiter / lockout, path traversal in the file endpoints (`/fs/*`, `/images/*`), the OTA updater, or a crafted frame that escalates beyond the permission gate.

## Known + accepted properties (by design — not vulnerabilities)

These are inherent to what the tool *is*; they're documented in the README's Security section:

- **The agent is not sandboxed.** `claude` runs as you, with your full machine access. `FS_ROOT` only scopes RoamCode's own file endpoints, not what `claude` can read/write.
- **A single shared token** grants full access (it's not per-user). Treat it like an SSH key; rotate via `POST /token/rotate`. The token must be kept off untrusted channels.
- **You must put HTTPS in front of it** for any remote use; a plain public port leaks the token.
- **Terminal mode is a raw host shell, on by default.** A "terminal" session runs the real `claude` TUI in a tmux+PTY and streams it to the browser over a token-gated WebSocket — i.e. an interactive shell on your machine. It rides the exact same token + origin/CSWSH + rate-limit gate as every other route (no separate gate), and it does **not** widen the trust boundary: a token holder can already run arbitrary commands through any session. It auto-disables when `tmux`/`node-pty` are unavailable on the host.

## Supported versions

This is a fast-moving single-branch project. Only the latest `main` (what the in-app OTA installs) is supported — please update before reporting, in case it's already fixed.
