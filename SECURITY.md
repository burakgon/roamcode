# Security Policy

RoamCode is, by design, **remote code execution on your own machine** — a credential-gated bridge that runs the real Claude Code or Codex CLI as your user. So security reports matter a lot. Thank you for helping.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use **GitHub's private vulnerability reporting**: the repo's **Security** tab → **Report a vulnerability**. (If that's unavailable to you, open a minimal issue saying only "security report — please open a private channel," with no details.)

Please include: what you found, how to reproduce it, the impact, and the affected stable version (`/version` → `runningVersion`). I'll acknowledge as quickly as I can and keep you posted on the fix.

## What's in scope

The interesting surface is everything reachable **before** the credential check, and anything that lets a request do more than its credential is meant to allow:

- Auth bypass (outside the documented static shell, `/health`, and capability-gated `/pairing/claim`), host/device/pairing credential leakage, one-use or expiry failures, broken device revocation, the cross-origin/CSWSH guard, the rate limiter / lockout, path traversal in the file endpoints (`/fs/*`, `/images/*`), the OTA updater, or a crafted frame that escalates beyond the permission gate.
- Blind-relay plaintext exposure, identity/key substitution, replay/reordering acceptance, cross-route forwarding,
  routing-capability leakage, revocation failure, unbounded frame/queue/rate behavior, or a relay management endpoint
  that exposes route secrets or accepts an unauthorized provisioning capability.
- Peer-federation identity/origin substitution, pairing replay, credential or remote-origin disclosure, workspace/action
  scope bypass, arbitrary URL/header/method forwarding, local-or-remote RBAC/policy bypass, or two simultaneous input
  writers through a federated session.

## Known + accepted properties (by design — not vulnerabilities)

These are inherent to what the tool *is*; they're documented in the README's Security section:

- **RoamCode does not sandbox the agent.** Claude Code or Codex runs as your host user. Codex's provider-native sandbox and both providers' approval controls can reduce risk, but they are not a separate RoamCode security boundary. `FS_ROOT` only scopes RoamCode's own file endpoints, not what either CLI can read/write.
- **A valid device key grants the installation's normal single-user access unless team role enforcement is enabled.**
  With enforcement enabled, server-side principal binding, role, resource scope, and organization policy apply to the
  PWA, CLI, API, terminal sockets, peer, and relay traffic. The host recovery key remains break-glass administration.
  Device keys are distinct and independently revocable; treat each like an SSH key. Pairing links are high-entropy
  capabilities that expire after five minutes and work once. A newly paired peer may read only the privacy-bounded
  capability document before team assignment; operational resources remain default-deny.
- **You must put HTTPS in front of it** for any remote use; a plain public port leaks device credentials and terminal data.
- **Terminal mode is a raw host shell, on by default.** A session runs the selected provider's real TUI in a tmux+PTY and streams it to the browser over a credential-gated WebSocket — i.e. an interactive shell on your machine. It rides the same credential + origin/CSWSH + rate-limit gate as every other route and does **not** narrow the trust boundary: a credential holder can choose provider-native safety settings, including an explicit dangerous mode. It auto-disables when `tmux`/`node-pty` are unavailable.
- **Provider metadata is auxiliary.** Codex account/model/rate-limit and exact-identity discovery use a bounded app-server client. Protocol failure is reported as degraded; it must not expose raw frames, credentials, login codes, or stop an already-running TUI. Exact Codex resume stays disabled when identity is missing or ambiguous rather than falling back to a global “last session.”
- **RoamCode never collects provider API keys.** Claude managed processes strip `ANTHROPIC_API_KEY`; Codex may already be authenticated by its own supported methods, but PWA-managed login is ChatGPT device code only. Attachment plumbing never puts the RoamCode bearer token in provider argv. Claude receives it through its mode-0600 MCP configuration artifact. For Codex, RoamCode removes inherited `RC_TOKEN`, writes a bounded per-session mode-0600 token file under the mode-0700 data directory, and gives the main Codex process only the `RC_TOKEN_FILE` path; the attachment MCP subprocess reads that file with owner, regular-file, permission, and size checks. The path is registered before writing, normal provider cleanup removes it, and startup removes stale artifacts left after interrupted cleanup.
- **Mode 0600 is not a same-user sandbox.** It protects the attachment credential from other host users, accidental argv exposure, and ordinary environment inheritance, but a process already running as the RoamCode host user can explicitly read files that user can read. This includes a provider tool deliberately directed to a known token-file path. RoamCode already grants that provider the host user's authority; a least-privilege, session-scoped attachment credential remains deferred hardening rather than a claimed boundary here.
- **The optional relay is a reachability service, not a sandbox or identity provider.** It routes ciphertext between
  already-paired endpoints. Direct access remains available without it, and a hosted relay is not declared
  production-ready before independent cryptographic and abuse-resistance review.
- **Peer federation is direct, explicit delegation rather than a sandbox.** The coordinating host stores a recoverable
  remote device credential in its private data directory and can perform only its configured action/workspace scope.
  The remote host still runs the provider as its own host user and independently enforces RBAC, policy, and its single-
  writer lease. HTTPS protects host-to-host traffic; the browser blind-relay E2E protocol is not currently a generic
  peer transport. See [the peer threat boundary](docs/peer-federation.md#security-and-failure-behavior).

## Supported versions

Only the latest stable SemVer release is supported. Please update through the app, npm, or Homebrew before reporting, in case it is already fixed. Drafts, prereleases, and arbitrary commits are never installed by OTA.
