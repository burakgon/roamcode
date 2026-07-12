# Codex support — design

**Date:** 2026-07-11
**Status:** Approved (autonomous run — user mandated full plan + implementation)
**Goal:** RoamCode can launch, drive, monitor, and resume **OpenAI Codex CLI** sessions exactly the way it does Claude Code sessions — same terminal bridge, same rail statuses, same pushes, same file exchange — with the agent chosen per session at creation time.

## Background

RoamCode today hardcodes one agent: the `claude` CLI. The mechanism is already largely agent-agnostic (a pty running `tmux new-session -A … -- <bin> <args>`), but the *vocabulary* is Claude-shaped in five places:

1. **Arg building** (`transport.ts` POST /sessions): `--model/--effort/--permission-mode/--dangerously-skip-permissions`.
2. **Status classification** (`pane-status.ts`): regexes over Claude's English TUI strings.
3. **Resume semantics** (`terminal-manager.ts` attach): `--continue` appended on respawn.
4. **Per-session config injection** (`config.ts`): `--mcp-config` (send_file/send_image) and `--settings` (hooks) — Claude Code flag/schema specific.
5. **Aux services**: usage (`claude -p /usage`), auth (`claude auth status/login`), version probe, npm latest-check, push copy ("Claude is waiting").

There is **no agent discriminator** in `CreateSessionBody`, `TerminalMeta`, or `StoredSession`. The `packages/protocol` package (Claude stream-JSON) is **not used by the terminal path** and is untracked source — out of scope.

## Codex CLI facts this design relies on

Verified against the official CLI reference and the `openai/codex` source (TUI snapshot fixtures), current release **0.144.x**:

- Interactive launch: `codex [flags]`. Resume: `codex resume --last` (cwd-scoped by default) — resume accepts the same global flags.
- Flags: `--model/-m <m>`, `-c key=value` (repeatable; dotted TOML key paths; values parse as JSON when possible, else literal string), `--sandbox/-s read-only|workspace-write|danger-full-access`, `--ask-for-approval/-a untrusted|on-request|never`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), `--add-dir <path>`, `--cd/-C <dir>`.
- Reasoning effort is config, not a flag: `-c model_reasoning_effort="minimal|low|medium|high|xhigh"`.
- Auth: `codex login status` → exit 0 + stderr `Logged in using ChatGPT` (or API key variants); exit 1 when logged out. Login itself is a browser OAuth flow on the host — not remotable in v1.
- MCP servers: `[mcp_servers.<name>]` config tables (`command`, `args`, `env` literal map, `env_vars` name-forwarding list). Injectable per-invocation via repeated `-c mcp_servers.…` overrides. Stdio MCP servers get a **whitelist env** (HOME, PATH, LANG…) + the literal `env` map — they do NOT inherit arbitrary parent env.
- TUI markers (from `codex-rs/tui` snapshot fixtures):
  - **working:** `• Working (0s • esc to interrupt)` — constant piece is `esc to interrupt`.
  - **blocked (approvals):** `Would you like to run the following command?`, `Would you like to make the following edits?`, footer `Press enter to confirm or esc to cancel`.
  - **blocked (questions):** `Question 1/1 …` with footer `tab to add notes | enter to submit answer | esc to interrupt` — note it *contains* "esc to interrupt", so blocked must be checked before working (same ordering the Claude classifier already uses).
  - **idle:** composer `› Ask Codex to do anything`, `? for shortcuts`, `N% context left`.
- Version: `codex --version` → `codex-cli X.Y.Z`. npm package `@openai/codex`.
- No CLI equivalent of Claude's `/usage` JSON — Codex usage bars are out of scope for v1.

## Approaches considered

**A. Per-agent adapter registry (chosen).** One new server module defines an `AgentAdapter` per agent (arg vocabulary, resume argv, pane classifier, env hygiene, version/auth probes, display name). Call sites ask the adapter instead of hardcoding Claude tokens. Smallest honest abstraction; both agents stay first-class; a third agent later is additive.

**B. Parallel Codex code paths** (codex-terminal-manager, codex-pane-status…). Rejected: duplicates the manager/transport logic that is genuinely agent-agnostic; double maintenance.

**C. Generic "custom command" escape hatch** (arbitrary bin+args per session). Rejected for v1: loses status classification, resume semantics, validation, and honest meta (model/effort badges) — the features that make RoamCode more than a web tmux.

## Design

### 1. Agent model (protocol-level)

- New union `AgentKind = "claude" | "codex"`, field name **`agent`**, optional everywhere with **absent ⇒ `"claude"`** (full back-compat: old stored rows, old clients).
- `CreateSessionBody.agent?`, `TerminalMeta.agent`, `StoredSession.agent?` + sqlite `ALTER TABLE sessions ADD COLUMN agent TEXT` best-effort migration (NULL ⇒ claude), echoed by `GET /sessions` and the `POST /sessions` response.

### 2. `packages/server/src/agents.ts` (new)

```ts
export type AgentKind = "claude" | "codex";
export interface AgentSpawnRequest {
  model?: string; effort?: string; permissionMode?: string;
  dangerouslySkip?: boolean; addDirs?: string[];
}
export interface AgentAdapter {
  kind: AgentKind;
  displayName: string;            // "Claude Code" / "Codex"
  binEnvVar: string;              // CLAUDE_BIN / CODEX_BIN
  defaultBin: string;             // "claude" / "codex"
  npmPackage: string;             // for the latest-version probe
  validEfforts: readonly string[];
  validPermissionModes: readonly string[];
  buildArgs(req: AgentSpawnRequest): string[];      // user-intent flags only
  resumeArgv(args: string[]): string[];             // full argv for a respawn-continue
  attachmentArgs(cfg: AttachmentArgConfig): string[]; // send_file/send_image wiring
  supportsHooks: boolean;                            // claude-only --settings hooks
  deriveMeta(args: string[]): { model?: string; effort?: string; dangerouslySkip: boolean };
  classifyPane(pane: string): PaneStatus;
  testedUpTo: string;                                // classifier version guard
  versionArgs: string[];                             // ["--version"]
  parseVersion(output: string): string | undefined;
}
export function agentFor(kind: AgentKind | undefined): AgentAdapter;
```

**Claude adapter** = today's behavior, verbatim: `--model`, `--effort`, `--permission-mode default|acceptEdits|plan`, `--dangerously-skip-permissions`, resume = `[...args, "--continue"]`, attachment = `--mcp-config <file>`, hooks supported, classifier = existing `classifyPaneStatus`, testedUpTo `2.1`.

**Codex adapter:**
- `buildArgs`: model → `--model <m>`; effort → `-c model_reasoning_effort="<e>"` (valid: minimal|low|medium|high|xhigh); permissionMode → `default` ⇒ nothing, `readOnly` ⇒ `--sandbox read-only`, `fullAuto` ⇒ `--full-auto`; dangerouslySkip → `--dangerously-bypass-approvals-and-sandbox`; addDirs → repeated `--add-dir <d>`.
- `resumeArgv(args)` = `["resume", "--last", ...args]` (subcommand first; global flags legal after it). `resume --last` is cwd-scoped, which matches the session's fixed cwd.
- `attachmentArgs`: repeated `-c` overrides registering the existing `mcp-send.js` stdio server:
  `-c mcp_servers.roamcode.command="<node>"`, `-c mcp_servers.roamcode.args=["<mcp-send.js>"]`,
  `-c mcp_servers.roamcode.env.RC_BASE_URL="…"`, `….env.RC_SESSION_ID="…"`, `….env.RC_TOKEN_FILE="<0600 auth file>"`.
  **The token itself never appears in argv** — only the path of the existing per-session 0600 auth file. `mcp-send.ts` learns `RC_TOKEN_FILE` (reads the file at call time, tolerating the `Authorization: Bearer ` prefix used by the hook-curl format, so the same file serves both consumers).
- `supportsHooks: false` — capture-pane is already the sole status authority, so Codex loses nothing.
- `deriveMeta`: `--model` positional scan; effort parsed out of the `-c model_reasoning_effort=…` pair; danger = `--dangerously-bypass-approvals-and-sandbox` present.
- `classifyPane` (tail-22-lines, blocked → working → idle, same shape as Claude's):
  - blocked: `/\bWould you like to run the following command\b/i`, `/\bWould you like to make the following edits\b/i`, `/\bPress enter to confirm or esc to cancel\b/i`, `/\benter to submit answer\b/i`
  - working: `/\besc to interrupt\b/i`, `/\bWorking\s*\(\s*\d+\s*[smh]/`
  - idle: fallback.
- `testedUpTo: "0.144"`, `npmPackage: "@openai/codex"`, version parse of `codex-cli X.Y.Z`.

### 3. Binary resolution & process env

- `config.ts`: `codexBin: env.CODEX_BIN ?? "codex"` next to the existing `claudeBin`. Threaded through `ServerRuntimeConfig` and `TerminalManagerDeps` as `bins: Record<AgentKind, string>` (replacing the single `claudeBin` dep; tests updated).
- `TerminalProcessOptions.claudeBin/claudeArgs` → renamed `bin`/`args` (TerminalProcess is genuinely agent-agnostic; contained rename, tests updated).
- Env hygiene: `TerminalProcess.start()` deletes **both** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (subscription-auth-only stance for both agents).

### 4. Session lifecycle changes

- `POST /sessions`: validate `agent` (400 on unknown), validate model/effort/permissionMode **against the chosen adapter**, build args via `adapter.buildArgs`. **Fixes the pre-existing dead `addDirs` input** (declared, persisted, never mapped) for both agents. If the agent's bin is missing on PATH → 503 with an agent-specific message (mirrors the Claude wording documented in troubleshooting).
- `TerminalManager.create/attach/rehydrate`: record + persist `agent`; per-session appends become adapter-driven (`attachmentArgs` for both, `--settings` hooks only when `supportsHooks`); respawn-continue uses `adapter.resumeArgv`; meta (model/effort/danger badges) via `adapter.deriveMeta`.
- `refreshActivity` classifies with the session's own adapter.
- Rehydrate: stored `agent` restored; absent ⇒ claude.

### 5. Aux services

- **/diag**: reports both agents (`{found, version}` each).
- **New `GET /agents`** (auth-required): `[{ kind, displayName, available, version?, authenticated? }]`. `authenticated` for codex = cached (60s TTL) `codex login status` exit-code probe; for claude = existing auth service summary. The wizard consumes this to enable/disable choices.
- **Usage** (`GET /usage`) unchanged — it describes the host's Claude account. No Codex bars in v1.
- **Claude in-app OAuth** unchanged, Claude-only. Codex shows status + "run `codex` on the host to sign in" guidance.
- **Boot preflight**: unchanged hard behavior for claude; adds a non-fatal one-line codex presence/version log, plus the classifier version warning per agent.
- **Push copy** (`push-dispatch.ts`): parameterized by agent display name — "Codex is waiting", "Codex sent a file", "Your Codex session has ended".

### 6. Web UI

- `SessionMeta.agent?`, `CreateSessionBody.agent?` in `types/server.ts` + `api/client.ts`; new `api.getAgents()`.
- `settings/defaults.ts`: `SessionDefaults.agent` (default `"claude"`); per-agent effort/permission option tables + labels (claude: low…max, default/acceptEdits/plan; codex: minimal…xhigh, default/readOnly/fullAuto).
- **NewSessionWizard**: a `SegmentedToggle` (existing component) "Claude Code | Codex" at the top of step 2. Switching swaps effort/permission options, the model placeholder (`e.g. claude-opus-4-8` vs `e.g. gpt-5.2-codex`), and the danger-checkbox label ("Dangerously skip permissions" vs "Bypass approvals and sandbox"). Codex option disabled with a hint when `GET /agents` says unavailable. Selection sent as `agent` in createSession.
- **SessionList**: small "Codex" tag on codex rows (claude rows unchanged — no clutter for the default).
- **ChatHeader** flags line + **SettingsPanel** "This session" block show the agent.
- **TerminalView** ended-overlay copy agent-aware ("codex exited …" guidance points at `codex login`).
- **SettingsPanel** defaults section gains the agent picker; HelpSheet notes Shift-Tab permission-cycling is Claude-specific.
- Onboarding/manifest copy generalized lightly ("Claude Code and Codex sessions").

### 7. CLI / install / docs

- `cli/args.ts` helpText: title line generalized; env list gains `CLAUDE_BIN`, `CODEX_BIN`.
- `scripts/install.sh`: non-fatal `codex` presence line next to the claude check (keeps install-smoke green).
- README: env table (`CODEX_BIN`), requirements ("Claude Code and/or Codex installed + logged in"), a short "Agents" note; `ANTHROPIC_API_KEY` bullet extended with `OPENAI_API_KEY`.
- `docs/troubleshooting.md`: codex twin of the "not found / not authenticated" section.
- CONTRIBUTING/SECURITY: one-line generalizations. CHANGELOG: `### Changed / added` bullet.
- **Out of scope:** marketing site (`site/`), launch kit, social preview, protocol package.

### 8. Error handling

- Unknown `agent` → 400. Codex bin missing at create → 503 agent-specific. Codex spawn failure at attach → existing 4404 path (unchanged mechanics).
- `codex resume --last` with no prior session in the cwd: codex handles it interactively (picker/new); the user sees the real TUI either way — no special server handling.
- Classifier misses on future Codex TUI rewording degrade to "idle" (same failure mode as Claude) — guarded by the per-agent `testedUpTo` boot warning.

### 9. Testing

- `agents.test.ts` — arg building (each knob, both agents), `resumeArgv`, `deriveMeta`, attachment argv shape (token path only, never the token), validators.
- `pane-status` codex fixtures lifted from the real `codex-rs` TUI snapshots (working line, exec approval, patch approval, request-user-input, idle composer) — working/blocked/idle each.
- `terminal-manager` — codex create argv (`-c mcp_servers…`, no `--settings`), respawn-continue = `resume --last` prefix, `agent` persisted + rehydrated.
- `session-store.migration` — `agent` column added; NULL reads as claude.
- `transport` — POST validation per agent (codex effort `max` rejected, claude `minimal` rejected), echo of `agent`, `GET /agents` shape, 503 on missing codex bin.
- `mcp-send` — `RC_TOKEN_FILE` (with and without the `Authorization: Bearer ` prefix).
- Web — defaults tables, wizard agent-picker behavior (new test), client body, SessionList tag.
- CLI — helpText env additions.

## Spec self-review

- No placeholders/TBDs; each area names concrete files and exact flags/markers.
- Consistency: adapter owns all agent vocabulary; no call site keeps hardcoded Claude tokens except Claude's own adapter.
- Scope: single implementation plan; site rebrand and Codex usage bars explicitly deferred.
- Ambiguity: permission-mode wire values for codex fixed as `default|readOnly|fullAuto`; absent-agent semantics fixed as claude everywhere.
