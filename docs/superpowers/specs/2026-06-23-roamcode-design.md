# roamcode — Design Spec

- **Status:** Approved (brainstorming) → ready for implementation planning
- **Date:** 2026-06-23
- **Working name:** `roamcode`
- **License:** MIT
- **Language (project + docs):** English

---

## 1. Summary

`roamcode` is a self-hosted server + installable web app (PWA) that lets you **start and operate Claude Code sessions on your own machine, entirely remotely** — from your phone or any browser. An always-on daemon runs on your dev machine, drives the real `claude` CLI as a subprocess (using your Claude **subscription**, no API key, no Agent SDK), and exposes a mobile-and-desktop UI with full feature parity to operating Claude Code through a rich chat client: streaming output, image input/output, file upload/download, interactive permission and question answering, effort/model switching, `--dangerously-skip-permissions` toggle, a working-directory picker, and multi-session management.

### Headline differentiator

Anthropic now ships first-party remote control (`claude remote-control`) and chat **Channels** (Telegram/Discord/iMessage). **But their biggest gap: you can only see and resume sessions that were already started *at the machine* — you cannot create a new chat remotely.** (`claude remote-control` must be launched locally; the channel plugins also **cannot answer terminal permission prompts**.)

`roamcode`'s always-on daemon flips this: you **spin up a brand-new session from scratch, remotely**, through a **first-class, beautifully designed directory picker** — pick a directory on your phone and go — and answer every interactive prompt remotely. That, plus **self-host + MIT + a true responsive PWA + first-class file/image + effort controls + secure-by-default auth**, is the wedge against both Anthropic's offering and the existing OSS field (much of which is unmaintained, AGPL, native-app-only, or ships with no auth).

---

## 2. Goals & non-goals

### Goals (v1)
- **Remote session start from scratch** (the headline feature), via an always-on daemon and a **first-class, beautifully designed directory picker**. Anthropic's remote control only lets you see/resume sessions already started at the machine; we let you create new ones from anywhere. The picker is a primary, polished surface — see §6.3.
- **100% feature parity** with operating Claude Code through a rich chat client:
  - Streaming responses with tool-use activity rendering.
  - **Image input** (send images) and **image output / display** (see images Claude produces or references).
  - **File upload and download** (send files to the session, retrieve artifacts).
  - **Interactive permission answering** (approve/deny tool use) and **interactive question answering** (AskUserQuestion-style prompts) — remotely, on mobile.
  - **Effort** switching (`low/medium/high/xhigh/max`) and **model** switching.
  - **`--dangerously-skip-permissions`** toggle (per session).
  - **Working-directory picker** and **multi-session** management.
  - **Session resume / history**.
- **Subscription auth only** — drive the local `claude` CLI; **no `ANTHROPIC_API_KEY`**, **no Agent SDK dependency**.
- **Great on both mobile and desktop** — one responsive PWA, installable, no app store.
- **Self-hostable**, **secure-by-default** (mandatory token), single-command run + Docker.

### Non-goals (v1; on roadmap)
- Multi-user accounts / RBAC (v1 is **single-user**).
- Built-in sandboxing (`/sandbox` bubblewrap/Seatbelt) and egress allowlisting.
- OIDC / SSO.
- Native mobile apps (PWA only).
- Remote OAuth login flow (host must already be logged into `claude`; see §8 limitation).

---

## 3. Constraints & key technical facts (verified)

Verified against the locally installed `claude` **v2.1.186** and Claude Code docs:

- **Subscription auth "just works":** with `ANTHROPIC_API_KEY` unset, a spawned `claude` subprocess uses the machine's stored subscription OAuth credentials. Auth precedence: Bedrock/Vertex/Foundry → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → subscription OAuth (default). For headless hosts, `claude setup-token` issues a 1-year `CLAUDE_CODE_OAUTH_TOKEN` (inference-only; cannot open Anthropic Remote Control sessions — irrelevant to us).
- **The programmatic primitive** is a single long-lived process:
  ```
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --include-partial-messages --session-id <uuid> [--effort <level>] [--model <m>] \
    [--permission-mode <mode> | --dangerously-skip-permissions]
  ```
  This gives continuous, multi-turn, bidirectional NDJSON over stdin/stdout — exactly the protocol the Agent SDK wraps. Driving the CLI directly yields the **same capabilities without the SDK**. Plain pipes; **no PTY required**.
- **Relevant flags confirmed present:** `--effort low|medium|high|xhigh|max`, `--model`, `--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan`, `--dangerously-skip-permissions`, `--session-id <uuid>`, `--resume`, `--continue`, `--fork-session`, `--add-dir`, `--allowedTools`/`--disallowedTools`/`--tools`, `--mcp-config`, `--file file_id:relative_path`, `--include-partial-messages`, `--replay-user-messages`, `--include-hook-events`, `--no-session-persistence`.
- **Images** are sent as base64 content blocks in a stream-json user message (vision limits: PNG/JPEG/GIF/WebP, ≤5 MB, ≤8000×8000).
- **Sessions** persist as JSONL transcripts in `~/.claude/projects/<project-hash>/<session-id>.jsonl`; multiple sessions run concurrently.

### Primary risk (and mitigation)
The **control protocol** for interactive permissions/questions (`control_request` / `control_response` over the stream) is **under-documented** in official docs and has at least one known rough edge (GitHub issue #34046). Since this protocol is the backbone of the "answer prompts remotely" requirement:

- **Step 0 (de-risk spike), before building features:** drive a real `claude` process with the stream-json protocol, trigger a permission request (default mode) and an interactive question, and **capture the exact `control_request` / `control_response` / user-message JSON**. Cross-check the wire format against the **open-source Agent SDK source used as a spec (not a dependency)**.
- The captured fixtures become the **golden test files** for the `protocol` package and the **mock `claude`** used in CI.
- All schema knowledge is isolated in one `protocol` module so a format change touches one place.

**Resolution (2026-06-23 — spike complete):** The protocol was captured from the real binary; canonical shapes live in [`docs/protocol-notes.md`](../../protocol-notes.md) with fixtures in `packages/protocol/fixtures/`. Key correction to the assumptions below: in **headless** stream-json, a default-mode tool is **auto-denied** and `can_use_tool` is **not** emitted (and `--permission-prompt-tool` does not exist in v2.1.186). The working remote-permission mechanism is **`initialize` handshake registering a `PreToolUse` hook → CLI emits a `hook_callback` `control_request` → we answer with a `control_response` carrying `hookSpecificOutput.permissionDecision`**. Envelope rule: `request_id` is top-level on requests, nested at `response.request_id` on responses, payload at `response.response`. The §7 data flow below is conceptually correct but the literal control messages follow `protocol-notes.md`.

---

## 4. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Tech stack | **Full TypeScript** — Node server + React/Vite PWA |
| How we drive Claude | **A — Raw CLI stream-json**, no SDK dependency (SDK source used only as protocol spec) |
| User model (v1) | **Single-user** (one mandatory access token), architected to allow multi-user later |
| Access model | **Public port** (direct internet), with a **mandatory access token** as a non-negotiable baseline |
| Name | `roamcode` |
| License | MIT |

---

## 5. Architecture

Three layers:

```
┌─────────────────────┐      WebSocket + REST       ┌──────────────────────────┐
│   PWA (React/Vite)  │ ◄────── (token auth) ─────► │   Server daemon (Node/TS) │
│  mobile + desktop   │                             │   always-on, single port  │
└─────────────────────┘                             └────────────┬─────────────┘
                                                                  │ spawn + stdin/stdout
                                                                  │ stream-json (NDJSON)
                                                   ┌──────────────▼──────────────┐
                                                   │  claude subprocess (N)       │
                                                   │  one per session             │
                                                   │  subscription auth, NO key   │
                                                   └──────────────────────────────┘
```

- **Server daemon** — always-on on the dev machine (systemd/launchd/Docker). The brain that can launch sessions from scratch; this is what enables remote session start.
- **PWA** — installable, responsive; identical code on phone and desktop.
- **`claude` subprocess** — the real engine; one process per session, each with its own cwd and settings.

---

## 6. Components

### 6.1 Server (each unit = one clear purpose, well-bounded, independently testable)

| Component | Responsibility | Depends on |
|---|---|---|
| `config` | Load port, bind address, access token, default model/effort, storage path from env/flags. | — |
| `auth` | Verify the access token on every HTTP request and WS handshake. Constant-time compare, rate-limit/lockout. Refuse to start if bound to a non-loopback address without a token. | `config` |
| `protocol` | **Pure functions.** Parse a stream-json line → a typed event; serialize an outbound user message / `control_response` → a JSON line. Includes the image content-block builder. No I/O — fully unit-testable. Encodes the (spike-verified) schema. | — |
| `claude-process` | Wrap a **single** spawned `claude` child: build argv from session config, manage stdin/stdout/stderr, emit parsed events (via `protocol`), accept outbound messages and control responses, detect exit/crash. | `protocol`, `config` |
| `session-manager` | Session lifecycle: create / list / get / resume / stop / status. Owns `sessionId → claude-process`. Lazy (re)spawn on demand; idle reaping policy. | `claude-process`, `persistence` |
| `transport` | WebSocket hub (per-session subscriptions, broadcast, backpressure, reconnect replay buffer) + REST endpoints (sessions, directory browse, file upload/download, push subscribe). | `auth`, `session-manager`, `fs-service`, `push` |
| `fs-service` | Directory listing for the picker (rooted/guarded), file read/write for uploads (into cwd or as image blocks) and downloads (artifacts). | `config` |
| `persistence` | Session registry + settings store (SQLite via `better-sqlite3`). Reuses `~/.claude/projects/*.jsonl` for history rather than duplicating it. | `config` |
| `push` | Web Push subscription registry + send ("permission needed", "task done"). | `config`, `persistence` |

### 6.2 Frontend (React + Vite + TypeScript)

- `api` (REST client) + `ws` (auto-reconnecting WebSocket) → **state store (Zustand)**.
- Screens / components:
  - **Login** (token entry, stored securely).
  - **SessionList** (+ status, last activity) and **NewSessionWizard** (directory picker → effort/model/permission settings → start).
  - **ChatView** → **MessageList** (assistant/user/tool events, markdown, syntax-highlighted code, **image display**, file chips) + **Composer** (text, **image upload** incl. mobile camera/gallery, **file upload**, slash commands).
  - **PermissionPrompt** and **QuestionPrompt** — inline, large tap targets, answerable on mobile.
  - **SettingsPanel** (per-session + defaults: effort, model, permission-mode, dangerously-skip toggle).
- **PWA layer:** service worker (Vite PWA plugin), manifest, Web Push opt-in, install prompt, offline-aware reconnect.

### 6.3 Directory picker — a first-class, designed experience

Starting a new session remotely is the product's headline, so the picker is a **primary surface, not a file-dialog afterthought**. Requirements:

- **Quick-start suggestions:** recent directories, pinned/favorite directories, and recent Claude projects discovered from `~/.claude/projects/*` — so the common case is one tap.
- **Fuzzy search** across the filesystem (from the host user's home or a configurable root) to jump to any directory fast.
- **Git-aware:** mark directories that are git repos and show the current branch; surface repos prominently.
- **Breadcrumb navigation** with up/into, large tap targets, and fast keyboard nav on desktop.
- **Mobile-first:** thumb-reachable, responsive, no hover-only affordances.
- **Validation + new folder:** confirm the path exists and is a directory; optionally create a directory inline.
- **Remembers** the last-used directory and per-directory default settings (effort/model/permission).

This is a named visual-design priority for implementation (handled with the frontend-design skill).

### 6.4 Repo layout (monorepo, pnpm workspaces)

```
packages/
  protocol/   # shared TS types + stream-json parse/serialize (used by server; types shared with web)
  server/     # Node daemon
  web/        # React/Vite PWA
docs/
  superpowers/specs/   # this spec
```

---

## 7. Data flow (one turn)

1. PWA: pick directory + settings → `POST /sessions` → server spawns (cwd = chosen dir):
   ```
   claude -p --input-format stream-json --output-format stream-json --verbose \
     --include-partial-messages --session-id <uuid> [--effort <level>] [--model <m>] \
     [--permission-mode default | --dangerously-skip-permissions]
   ```
2. Server reads the `init` event (session_id, model, tools) → persists registry entry → notifies the client over WS.
3. User sends a message (+ optional image/file) → WS → server → `protocol` serializes a stream-json user message (with base64 image content blocks if any) → write to `claude` stdin.
4. `claude` streams events (text deltas, tool_use, etc.) → server parses via `protocol` → WS broadcast → PWA renders live.
5. **Permission moment** (default mode): `claude` emits `control_request` → server → WS → PWA shows approve/deny → user taps → WS → server → `control_response` to `claude` stdin. **AskUserQuestion**-type prompts follow the same path.
6. `result` event → server marks the turn complete; if the PWA is backgrounded, send a **Web Push**.
7. Files/images `claude` creates or references → exposed by `fs-service` for download/display in the PWA.

**Resilience win:** if the phone disconnects mid-task, the **daemon keeps running the task**; on reconnect the PWA catches up via the replay buffer + transcript. (A known weakness of competitors and Anthropic Remote Control.)

---

## 8. Persistence & resume

- We assign our own UUID via `--session-id` → we own the IDs.
- `persistence` (SQLite) stores per session: `sessionId`, `cwd`, display name, settings (effort/model/permission-mode/dangerously-skip), status (`idle|running|errored|stopped`), created/last-activity timestamps, and token/cost extracted from `result` events.
- **History** is already kept by Claude in `~/.claude/projects/<hash>/<session-id>.jsonl`; we **load from there** on open instead of duplicating it.
- **Resume:** after a server restart or subprocess exit, the next user message lazily respawns `claude --resume <session-id>` in the same cwd; the conversation continues.
- **Lifecycle policy:** keep the process alive while a task runs; reap long-idle sessions (configurable) and resume on next message → memory-efficient with many sessions.
- Multiple sessions run concurrently; each has its own process + cwd.

---

## 9. Security (v1 baseline — public port)

- **Mandatory access token:** a long random secret generated on first run (printed once, stored). Required on every HTTP request (`Authorization`) and WS handshake. **If bound to a non-loopback address with no token, the server refuses to start.** Non-negotiable baseline.
- **HTTPS:** Web Push requires HTTPS, and a public port without TLS leaks the token. Recommended setup: **Caddy** (automatic HTTPS) via the provided docker-compose; documented alternatives: Cloudflare Tunnel / Tailscale Funnel.
- **Auth hardening:** constant-time token comparison, rate-limit + temporary lockout on failed auth, generic 401s.
- **`--dangerously-skip-permissions` toggle:** per session, off by default, shown in the UI as dangerous (red + confirmation). The honest RCE risk is documented.
- **Threat-model doc:** clearly state that this is, by design, remote code execution on the host; recommend HTTPS + token, ideally on a private network, on a machine treated as semi-disposable. The CLI itself refuses to run as root/sudo.
- **Roadmap (deferred, but architecture leaves room):** sandbox integration (`/sandbox` bubblewrap/Seatbelt), egress allowlist, multi-user + RBAC, OIDC.

---

## 10. Error handling & resilience

- `claude` exits unexpectedly → emit `session.error`, mark errored, offer one-tap resume.
- **Malformed stream-json line → log + skip; the parser never crashes the server** (defensive, since the schema is reverse-engineered).
- stderr captured → surfaced as diagnostics (e.g., "auth expired → re-login on the host" — remote OAuth login is not supported; see §8/non-goals).
- **Backpressure:** per-client send queue; coalesce partial deltas when slow, but **never drop final messages or `control_request`s** (a permission prompt must never be lost).
- **WS reconnect:** per-session ring buffer of recent events replayed on reconnect; full history from the transcript.
- Upload limits: images ≤5 MB (vision limit); general files have a configurable cap; oversized uploads rejected with a clear error.
- Idempotency guard on session create.

---

## 11. Testing

- **Unit (highest value):** `protocol` parse/serialize — golden tests from **real captured stream-json** (from Step 0), including `control_request`/`control_response` and image messages. Locks the risky reverse-engineered part.
- **Mock `claude` binary:** a small fake that replays recorded fixtures — deterministic, no subscription/credit spend, CI-safe. Integration-tests `session-manager` + `transport` + a full turn including a permission round-trip.
- **E2E:** Playwright against the PWA + mock backend (login, new session, chat, approve permission, upload image, download file).
- **CI:** lint + typecheck + unit/integration + build. Live tests (real `claude`) are opt-in/manual, excluded from CI.

---

## 12. Distribution & community (for adoption)

- **`npx roamcode`** one-command run + official **Docker image** + **docker-compose** (with Caddy for HTTPS).
- **Killer README:** hero = "start Claude Code sessions fully remotely"; GIF/screenshots; a comparison table vs Anthropic Remote Control & the main OSS competitors; an honest security section; a 60-second quickstart.
- CONTRIBUTING, issue/PR templates, CI badges, public roadmap.

---

## 13. Implementation order (high level — detail goes in the plan)

0. **De-risk spike:** capture the real stream-json + control protocol; produce fixtures. *(Gates everything.)*
1. `protocol` package (parse/serialize) with golden tests + mock `claude`.
2. `claude-process` + `session-manager` (spawn, one turn, resume) over the mock, then live.
3. `transport` (WS + REST) + `auth` + `config`.
4. PWA shell: login, session list, new-session wizard, chat view with streaming.
5. Interactive prompts (permission + question) end-to-end.
6. Images (in/out), files (up/down).
7. Effort/model/permission settings + dangerously-skip toggle.
8. Persistence/resume + reconnect replay.
9. Web Push, PWA polish (install, offline).
10. Security pass, Docker/Caddy, README/docs, CI.

---

## 14. Open questions / to resolve during planning

- Exact `control_request`/`control_response`/user-message JSON shapes — **resolved by Step 0**.
- Whether to expose slash commands directly in the composer for v1 (likely yes; low cost).
- SQLite vs a simpler JSON store — defaulting to SQLite (`better-sqlite3`) for concurrent-session metadata.
- Directory-picker rooting policy (allow any path the host user can access, vs a configurable root allowlist).
