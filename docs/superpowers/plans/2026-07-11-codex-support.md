# Codex Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex CLI as a second, per-session selectable agent with full parity: launch, resume, live status, pushes, file exchange, badges, docs.

**Architecture:** A per-agent adapter registry (`packages/server/src/agents.ts`) owns all agent vocabulary (argv building, resume argv, pane classification, meta derivation, probes). Everything else (tmux/pty bridge, manager, transport, store) becomes agent-parameterized via a new optional `agent: "claude" | "codex"` field (absent ⇒ claude).

**Tech Stack:** TypeScript (Node ≥24), Fastify, node-pty + tmux, better-sqlite3, React 19 + Zustand + xterm.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-codex-support-design.md` (read it first — it holds the verified Codex CLI facts).

## Global Constraints

- `agent` absent anywhere (wire, DB, meta) ⇒ `"claude"`. Old clients/rows keep working unchanged.
- Access token must NEVER appear in any argv (only 0600-file paths may).
- Codex effort values: `minimal|low|medium|high|xhigh` (via `-c model_reasoning_effort="…"`); Claude: `low|medium|high|xhigh|max` (via `--effort`).
- Codex permission wire values: `default|readOnly|fullAuto`; Claude keeps `default|acceptEdits|plan|bypassPermissions`.
- Codex danger flag: `--dangerously-bypass-approvals-and-sandbox`; Claude: `--dangerously-skip-permissions`.
- Codex resume argv: `["resume", "--last", ...flags]` (prefix); Claude: `[...flags, "--continue"]` (suffix).
- Commit style: `feat(scope): …` / `fix(scope): …`, NO AI attribution lines.
- Repo checks that must stay green after every task: `pnpm typecheck && pnpm lint && pnpm test`.

---

### Task 1: Codex pane classifier (`pane-status.ts`)

**Files:**
- Modify: `packages/server/src/pane-status.ts`
- Test: `packages/server/test/pane-status.test.ts` (append)

**Interfaces:**
- Produces: `classifyCodexPaneStatus(pane: string): PaneStatus`, `CODEX_CLASSIFIER_TESTED_UP_TO = "0.144"`, and generalized `classifierVersionWarning(version, agent?)` — consumed by Task 2 (adapters) and Task 8 (start.ts).

- [ ] **Step 1: Write failing tests** — append to `packages/server/test/pane-status.test.ts` fixtures lifted from real `codex-rs` TUI snapshots:

```ts
describe("classifyCodexPaneStatus", () => {
  it("working: the status row", () => {
    expect(classifyCodexPaneStatus("• Working (0s • esc to interrupt)")).toBe("working");
    expect(classifyCodexPaneStatus("• Working (2m 13s • esc to interrupt)\n")).toBe("working");
  });
  it("blocked: exec approval modal", () => {
    const pane = [
      "  Would you like to run the following command?", "",
      "  $ echo hello world", "",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `echo hello world` (p)",
      "  3. No, and tell Codex what to do differently (esc)", "",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(classifyCodexPaneStatus(pane)).toBe("blocked");
  });
  it("blocked: patch approval modal", () => {
    expect(classifyCodexPaneStatus("  Would you like to make the following edits?\n\n› 1. Yes, proceed (y)")).toBe("blocked");
  });
  it("blocked: request-user-input beats its own 'esc to interrupt' footer", () => {
    const pane = [
      "  Question 1/1 (1 unanswered)",
      "  Choose an option.", "",
      "  › 1. Option 1  First choice.",
      "    2. Option 2  Second choice.", "",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ].join("\n");
    expect(classifyCodexPaneStatus(pane)).toBe("blocked");
  });
  it("idle: composer at rest", () => {
    expect(classifyCodexPaneStatus("› Ask Codex to do anything\n\n  ? for shortcuts            100% context left")).toBe("idle");
  });
  it("only reads the tail (scrollback immunity)", () => {
    const scrollback = Array(40).fill("Would you like to run the following command?").join("\n");
    expect(classifyCodexPaneStatus(scrollback + "\n" + Array(23).fill("plain output").join("\n"))).toBe("idle");
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/server/test/pane-status.test.ts` → FAIL (`classifyCodexPaneStatus` not exported).
- [ ] **Step 3: Implement** in `pane-status.ts` (mirror the Claude classifier's tail-22 + blocked→working→idle shape):

```ts
export const CODEX_CLASSIFIER_TESTED_UP_TO = "0.144";

export function classifyCodexPaneStatus(pane: string): PaneStatus {
  const tail = pane.split("\n").slice(-22).join("\n");
  // BLOCKED — Codex's approval modals + request-user-input. Checked FIRST because the
  // request-user-input footer itself contains "esc to interrupt".
  if (/\bWould you like to run the following command\b/i.test(tail)) return "blocked";
  if (/\bWould you like to make the following edits\b/i.test(tail)) return "blocked";
  if (/\bPress enter to confirm or esc to cancel\b/i.test(tail)) return "blocked";
  if (/\benter to submit answer\b/i.test(tail)) return "blocked";
  // WORKING — the live status row: "• Working (2m 13s • esc to interrupt)".
  if (/\besc to interrupt\b/i.test(tail)) return "working";
  if (/\bWorking\s*\(\s*\d+\s*[smh]/.test(tail)) return "working";
  return "idle";
}
```

Also generalize the boot warning (keep the old 1-arg call working):

```ts
export function classifierVersionWarning(
  version: string | undefined,
  agent: { name: string; testedUpTo: string } = { name: "claude", testedUpTo: CLASSIFIER_TESTED_UP_TO },
): string | undefined {
  if (!version || !isNewerMajorMinor(version, agent.testedUpTo)) return undefined;
  return (
    `pane-status markers were verified against ${agent.name} <=${agent.testedUpTo}; ` +
    `current is ${version} — verify rail statuses after this upgrade`
  );
}
```

- [ ] **Step 4: Run tests** → PASS (including the existing claude cases untouched).
- [ ] **Step 5: Commit** `feat(server): codex pane-status classifier`

---

### Task 2: Agent adapter registry (`agents.ts`)

**Files:**
- Create: `packages/server/src/agents.ts`
- Test: `packages/server/test/agents.test.ts`

**Interfaces (produced — later tasks depend on these exact names):**

```ts
export type AgentKind = "claude" | "codex";
export const AGENT_KINDS: readonly AgentKind[];
export interface AgentSpawnRequest {
  model?: string; effort?: string; permissionMode?: string;
  dangerouslySkip?: boolean; addDirs?: string[];
}
export interface AttachmentArgConfig {
  nodeBin: string; mcpScriptPath: string; baseUrl: string; sessionId: string; tokenFilePath: string;
}
export interface AgentAdapter {
  kind: AgentKind; displayName: string;
  binEnvVar: string; defaultBin: string; npmPackage: string;
  validEfforts: ReadonlySet<string>; validPermissionModes: ReadonlySet<string>;
  buildArgs(req: AgentSpawnRequest): string[];
  resumeArgv(args: readonly string[]): string[];
  attachmentArgs(cfg: AttachmentArgConfig): string[];  // codex only; claude returns [] (it uses --mcp-config files)
  supportsHooks: boolean;
  deriveMeta(args: readonly string[]): { model?: string; effort?: string; dangerouslySkip: boolean };
  classifyPane(pane: string): PaneStatus;
  testedUpTo: string;
  parseVersion(raw: string): string | undefined;
}
export function agentFor(kind: string | undefined): AgentAdapter;   // absent/unknown-safe: undefined ⇒ claude
export function isAgentKind(v: unknown): v is AgentKind;
```

- [ ] **Step 1: Write failing tests** `packages/server/test/agents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentFor, isAgentKind } from "../src/agents.js";

describe("claude adapter", () => {
  const a = agentFor("claude");
  it("builds args exactly as the legacy transport did, plus add-dirs", () => {
    expect(
      a.buildArgs({ model: "opus", effort: "max", permissionMode: "plan", addDirs: ["/x", "/y"] }),
    ).toEqual(["--model", "opus", "--effort", "max", "--permission-mode", "plan", "--add-dir", "/x", "--add-dir", "/y"]);
  });
  it("danger flag wins over permissionMode", () => {
    expect(a.buildArgs({ dangerouslySkip: true, permissionMode: "plan" })).toEqual(["--dangerously-skip-permissions"]);
  });
  it("resume appends --continue", () => {
    expect(a.resumeArgv(["--model", "opus"])).toEqual(["--model", "opus", "--continue"]);
  });
  it("derives meta from args", () => {
    expect(a.deriveMeta(["--model", "opus", "--effort", "max", "--dangerously-skip-permissions"]))
      .toEqual({ model: "opus", effort: "max", dangerouslySkip: true });
  });
});

describe("codex adapter", () => {
  const c = agentFor("codex");
  it("builds codex-vocabulary args", () => {
    expect(
      c.buildArgs({ model: "gpt-5.2-codex", effort: "xhigh", permissionMode: "readOnly", addDirs: ["/x"] }),
    ).toEqual([
      "--model", "gpt-5.2-codex",
      "-c", 'model_reasoning_effort="xhigh"',
      "--sandbox", "read-only",
      "--add-dir", "/x",
    ]);
  });
  it("fullAuto and danger", () => {
    expect(c.buildArgs({ permissionMode: "fullAuto" })).toEqual(["--full-auto"]);
    expect(c.buildArgs({ dangerouslySkip: true, permissionMode: "fullAuto" }))
      .toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
  it("resume prefixes the subcommand", () => {
    expect(c.resumeArgv(["--model", "gpt-5.2-codex"])).toEqual(["resume", "--last", "--model", "gpt-5.2-codex"]);
  });
  it("attachment args register mcp-send via -c overrides, token as FILE PATH only", () => {
    const args = c.attachmentArgs({
      nodeBin: "/usr/bin/node", mcpScriptPath: "/app/mcp-send.js",
      baseUrl: "http://127.0.0.1:1", sessionId: "s1", tokenFilePath: "/data/hook-auth-s1",
    });
    expect(args).toEqual([
      "-c", 'mcp_servers.roamcode.command="/usr/bin/node"',
      "-c", 'mcp_servers.roamcode.args=["/app/mcp-send.js"]',
      "-c", 'mcp_servers.roamcode.env.RC_BASE_URL="http://127.0.0.1:1"',
      "-c", 'mcp_servers.roamcode.env.RC_SESSION_ID="s1"',
      "-c", 'mcp_servers.roamcode.env.RC_TOKEN_FILE="/data/hook-auth-s1"',
    ]);
    expect(args.join(" ")).not.toContain("RC_TOKEN=");
  });
  it("derives meta back out of codex args", () => {
    expect(c.deriveMeta(["--model", "gpt-5.2-codex", "-c", 'model_reasoning_effort="high"']))
      .toEqual({ model: "gpt-5.2-codex", effort: "high", dangerouslySkip: false });
    expect(c.deriveMeta(["--dangerously-bypass-approvals-and-sandbox"]).dangerouslySkip).toBe(true);
  });
  it("parses codex --version output", () => {
    expect(c.parseVersion("codex-cli 0.144.1")).toBe("0.144.1");
  });
});

describe("agentFor / isAgentKind", () => {
  it("absent ⇒ claude; unknown is not a kind", () => {
    expect(agentFor(undefined).kind).toBe("claude");
    expect(isAgentKind("codex")).toBe(true);
    expect(isAgentKind("gemini")).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement `packages/server/src/agents.ts`** (JSON.stringify for every interpolated `-c` value so paths/URLs are correctly TOML/JSON-quoted; validEfforts/validPermissionModes per Global Constraints; claude `deriveMeta` = the old `flagValueOf` + danger-includes logic; codex effort parse = scan `-c` pairs for `model_reasoning_effort=`; `classifyPane` delegates to `classifyPaneStatus` / `classifyCodexPaneStatus`; `parseVersion` reuses `parseClaudeVersion`'s dotted-token regex).
- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit** `feat(server): agent adapter registry (claude + codex vocabularies)`

---

### Task 3: `mcp-send` learns `RC_TOKEN_FILE`

**Files:**
- Modify: `packages/server/src/mcp-send.ts`
- Test: `packages/server/test/mcp-send.test.ts` (append)

**Interfaces:**
- `McpEnv` gains `RC_TOKEN_FILE?: string`; `deliver(env, args, fetchImpl?, readFileImpl?)` — new optional injectable `readFileImpl: (p: string) => string` (defaults to `readFileSync(p, "utf8")`).
- Token resolution: `RC_TOKEN` wins if set; else read `RC_TOKEN_FILE`, trim, and strip an optional `Authorization: Bearer ` prefix (the file is shared with the hook-curl format).

- [ ] **Step 1: Tests** (append):

```ts
it("reads the token from RC_TOKEN_FILE, stripping the curl header prefix", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  const read = vi.fn(() => "Authorization: Bearer sekrit\n");
  const res = await deliver(
    { RC_BASE_URL: "http://x", RC_SESSION_ID: "s", RC_TOKEN_FILE: "/data/hook-auth-s" },
    { path: "/tmp/a.png", kind: "image" }, fetchMock as unknown as typeof fetch, read,
  );
  expect(read).toHaveBeenCalledWith("/data/hook-auth-s");
  expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer sekrit" });
  expect(res.isError).toBeUndefined();
});
it("errors cleanly when the token file is unreadable", async () => {
  const res = await deliver(
    { RC_BASE_URL: "http://x", RC_SESSION_ID: "s", RC_TOKEN_FILE: "/nope" },
    { path: "/tmp/a", kind: "file" }, vi.fn() as unknown as typeof fetch,
    () => { throw new Error("ENOENT"); },
  );
  expect(res.isError).toBe(true);
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implement (token resolution helper inside `deliver`; a bare-token file (no prefix) must also work). **Step 4:** PASS. **Step 5: Commit** `feat(server): mcp-send accepts RC_TOKEN_FILE (token stays out of argv)`

---

### Task 4: `TerminalProcess` generalization

**Files:**
- Modify: `packages/server/src/terminal-process.ts` (`claudeBin`→`bin`, `claudeArgs`→`args`; delete `OPENAI_API_KEY` next to `ANTHROPIC_API_KEY`)
- Modify callers: `packages/server/src/terminal-manager.ts` (mechanical option rename only in this task)
- Test: `packages/server/test/terminal-process.test.ts` (rename fields; add env assertion)

- [ ] Step 1: failing test — spawn env lacks both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` when both set in opts.env; options named `bin`/`args`.
- [ ] Step 2–4: rename + `delete env.OPENAI_API_KEY;` (comment: subscription-auth only for BOTH agents); run suite.
- [ ] Step 5: Commit `refactor(server): TerminalProcess is agent-agnostic (bin/args, strips both API keys)`

---

### Task 5: Store gains `agent`

**Files:**
- Modify: `packages/server/src/session-store.ts`
- Test: `packages/server/test/session-store.test.ts`, `session-store.migration.test.ts` (append)

**Interfaces:** `StoredSession.agent?: "claude" | "codex"` (absent ⇒ claude). Column `agent TEXT` (nullable), best-effort `ALTER TABLE sessions ADD COLUMN agent TEXT` in the migration block; `rowToSession` only carries a REAL value (`"codex"`), NULL/`"claude"` stays absent (keeps old toEqual tests intact); `upsert` writes `s.agent ?? null` — write `null` for claude to keep rows canonical. In-memory store passes the field through.

- [ ] Steps: failing tests (round-trip codex agent; migration adds column on a pre-agent DB; NULL reads back absent) → implement → suite green → Commit `feat(server): persist per-session agent`

---

### Task 6: `TerminalManager` goes multi-agent

**Files:**
- Modify: `packages/server/src/terminal-manager.ts`
- Test: `packages/server/test/terminal-manager.test.ts` (append + adjust deps)

**Interfaces:**
- `TerminalManagerDeps`: `claudeBin: string` → **`bins: Record<AgentKind, string>`**.
- `TerminalMeta.agent: AgentKind`; `create(opts)` gains `agent?: AgentKind`; internal `Record_.claudeArgs` → `args`, plus `agent: AgentKind`.
- Behavior:
  - `create()`: adapter = `agentFor(opts.agent)`; meta model/effort/danger via `adapter.deriveMeta(args)`; per-session appends: claude keeps `--mcp-config` + `--settings` exactly as today; codex gets `writeAuthFile(id)` (extract the auth-file write out of `writeHooksConfig` into a shared private helper) + `adapter.attachmentArgs({ nodeBin: process.execPath, mcpScriptPath, baseUrl, sessionId: id, tokenFilePath })`; store `agent`.
  - `attach()` respawn-continue: `adapter.resumeArgv(rec.args)` instead of the hardcoded `--continue` append; rehydrated-record config regeneration branches per agent the same way create does.
  - `refreshActivity()`: `agentFor(rec.meta.agent).classifyPane(pane)` instead of the bare `classifyPaneStatus`.
  - `rehydrate()`: restore `agent` from the stored row; meta via the right adapter's `deriveMeta`.
  - `killTmux()` / `new TerminalProcess({...})`: use `bins[rec.meta.agent]` and the Task-4 `bin`/`args` names.
- [ ] Steps (TDD, three focused failing tests first):

```ts
it("codex create: argv has -c mcp overrides + no --settings; agent persisted", () => { /* fake ptySpawn captures args; assert
  args include ["-c", expect.stringContaining("mcp_servers.roamcode.command")], not include "--settings";
  store row has agent === "codex" */ });
it("codex respawn=continue spawns `resume --last` FIRST", () => { /* end the session, re-attach with respawn:"continue",
  assert captured argv starts ["resume","--last"] and --continue is absent */ });
it("classifies with the session's own agent", async () => { /* capturePane returns "• Working (0s • esc to interrupt)";
  claude session reads working (its own regex also matches), codex approval pane reads blocked only for codex */ });
```

  → implement → whole manager suite green (existing claude expectations must not change) → Commit `feat(server): terminal manager spawns/classifies per agent`

---

### Task 7: Transport — create/list with `agent`, addDirs fix, `GET /agents`

**Files:**
- Modify: `packages/server/src/transport.ts`, `packages/server/src/config.ts`, `packages/server/src/server-config.ts`, `packages/server/src/push-dispatch.ts`, `packages/server/src/diag.ts` (probe reuse only)
- Test: `packages/server/test/transport.rest.test.ts` (+ append `transport.agents.test.ts`), `push-dispatch.test.ts`, `server-config.test.ts`

**Interfaces:**
- `ServerConfig` = `{ claudeBin: string; codexBin: string }`; `loadConfig`: `codexBin: env.CODEX_BIN ?? "codex"`.
- `CreateSessionBody.agent?: string` — 400 `invalid agent` unless `isAgentKind`; validation of model/effort/permissionMode against `adapter.validEfforts` / `adapter.validPermissionModes`; args via `adapter.buildArgs({ model, effort, permissionMode, dangerouslySkip, addDirs })` — **this also fixes the dead `addDirs` input** (validate: array of strings, each an existing directory via `stat`, else 400).
- POST/GET session payloads echo `agent: meta.agent` (always present server-side; claude for old rows).
- **`GET /agents`** (authed): `{ agents: [{ kind, displayName, available, version?, authenticated? }] }` — reuse `createClaudeVersionProbe` with `defaultRunClaudeVersion(bin, env)` per agent (rename import alias, no behavior change), plus a codex-only cached (60s) `execFile(codexBin, ["login","status"])` exit-code probe → `authenticated: true|false`, absent on spawn error.
- Push copy: `PushEvent` gains `agentName?: string`; transport stamps `agentFor(terminalManager.get(id)?.agent).displayName`; `buildPushPayload` uses `event.agentName ?? "Claude"`: "Codex is waiting", "Codex sent a file", "Your Codex session has ended".
- [ ] Steps: failing tests (codex create → 201 echoes agent + argv assertions via injected manager; claude effort `minimal` → 400; codex effort `max` → 400; codex permissionMode `plan` → 400; addDirs mapped for claude; GET /agents shape with mocked probes; push payload says Codex) → implement → suite green → Commit `feat(server): agent-aware create/list, GET /agents, agent push copy, addDirs fix`

---

### Task 8: Boot wiring (`start.ts`)

**Files:**
- Modify: `packages/server/src/start.ts`
- Test: `packages/server/test/start.preflight.test.ts` (append)

Changes: pass `bins: { claude: cfg.claude.claudeBin, codex: cfg.claude.codexBin }` to the manager; non-fatal boot log line for codex presence/version (mirror `runClaudePreflight`, warn-only, never throws); per-agent classifier version warning via the generalized `classifierVersionWarning` (claude: existing behavior; codex: only when codex is present). Commit `feat(server): boot preflight + classifier guard for codex`

---

### Task 9: Web — types, client, defaults

**Files:**
- Modify: `packages/web/src/types/server.ts` (`SessionMeta.agent?: "claude" | "codex"`; new `AgentInfo` type), `packages/web/src/api/client.ts` (`CreateSessionBody.agent?`, `getAgents(): Promise<AgentInfo[]>` hitting `GET /agents`), `packages/web/src/settings/defaults.ts`
- Test: `packages/web/src/settings/defaults.test.ts`, `packages/web/src/api/client.test.ts`

**`defaults.ts` produces (consumed by Tasks 10–11):**

```ts
export type AgentKind = "claude" | "codex";
export const AGENTS: readonly AgentKind[] = ["claude", "codex"];
export const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
export const EFFORTS_BY_AGENT: Record<AgentKind, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};
export const PERMISSION_MODES_BY_AGENT: Record<AgentKind, readonly string[]> = {
  claude: ["default", "acceptEdits", "plan"],
  codex: ["default", "readOnly", "fullAuto"],
};
export const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: "Default (ask)", acceptEdits: "Accept edits", plan: "Plan mode",
  readOnly: "Read only", fullAuto: "Full auto (sandboxed)",
};
export const DANGER_LABEL: Record<AgentKind, string> = {
  claude: "Dangerously skip permissions", codex: "Bypass approvals and sandbox",
};
export const MODEL_PLACEHOLDER: Record<AgentKind, string> = {
  claude: "e.g. claude-opus-4-8", codex: "e.g. gpt-5.2-codex",
};
```

Keep the legacy `EFFORTS`/`PERMISSION_MODES` exports as aliases of the claude entries (other files import them). `SessionDefaults` gains `agent: AgentKind` (default `"claude"`); `loadDefaults` tolerates stored objects without it. Steps: failing tests → implement → green → Commit `feat(web): agent-aware types, client, session defaults`

---

### Task 10: Web — NewSessionWizard agent picker

**Files:**
- Modify: `packages/web/src/session/NewSessionWizard.tsx`
- Create: `packages/web/src/session/NewSessionWizard.test.tsx`

Behavior: a `SegmentedToggle` "Claude Code | Codex" at the top of step 2 bound to `agent` state (seeded from `SessionDefaults.agent`); on switch, effort resets to the agent default (`claude: "high"` → keep current wizard default; codex: `"high"`), permissionMode resets to `"default"`, model placeholder + help-text swap, danger checkbox label from `DANGER_LABEL`. `api.getAgents()` fetched on mount; codex segment disabled with hint `Codex CLI not found on the host` when `available === false` (fetch failure ⇒ leave enabled — the server will 503 with a precise error). `createSession({ …, agent })`. Tests: picker renders both agents; switching swaps effort options; codex submit posts `agent: "codex"`; disabled state honors `getAgents`. Commit `feat(web): agent picker in the new-session wizard`

---

### Task 11: Web — surfacing (list tag, header, settings, overlay, help, copy)

**Files:**
- Modify: `packages/web/src/session/SessionList.tsx` (small `Codex` tag on codex rows, in the `rc-sl__sub` meta line), `packages/web/src/chat/ChatHeader.tsx` (agent name in the flags line), `packages/web/src/settings/SettingsPanel.tsx` (defaults agent picker + "This session" shows agent), `packages/web/src/chat/TerminalView.tsx` (ended-overlay copy: `claude exited` → `${agentLabel} exited`, sign-in hint per agent: claude → Settings → Claude account; codex → `run codex on the host to sign in`), `packages/web/src/chat/HelpSheet.tsx` (Shift-Tab note marked Claude-only), `packages/web/src/App.tsx` (onboarding copy generalized: "Sessions run the claude or codex CLI…"), `packages/web/src/pwa/manifest.ts` (description: `"Operate Claude Code and Codex sessions on your machine, remotely."`)
- Test: `SessionList.test.tsx` (codex tag appears; claude rows unchanged), `manifest.test.ts` (updated string)

Steps: failing tests → edits → web suite green → Commit `feat(web): codex badges + agent-aware copy`

---

### Task 12: CLI + install + docs

**Files:**
- Modify: `packages/cli/src/args.ts` (helpText title → `roamcode — operate Claude Code and Codex sessions on this machine, remotely.`; env list gains `CLAUDE_BIN`, `CODEX_BIN` lines), `packages/cli/test/args.test.ts`
- Modify: `scripts/install.sh` (after the claude block: same-shape non-fatal `codex` check — found → `Found codex <version>`, missing → `note: codex CLI not found — Codex sessions need it; claude-only setups can ignore this.`)
- Modify: `README.md` (env table row `CODEX_BIN | codex | Path/name of the Codex CLI to spawn (optional — only for Codex sessions).`; requirements line → "Claude Code (and optionally Codex) installed + logged in"; API-key bullet → "`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are always stripped from spawned agents (subscription auth only)."; a short "### Agents" paragraph under What you can do)
- Modify: `docs/troubleshooting.md` (codex twin section: 503 message, `CODEX_BIN` override, `codex login` on the host), `docs/windows-wsl.md` (optional codex install note), `CONTRIBUTING.md:19` ("Claude Code (or Codex) installed and logged in"), `SECURITY.md` ("the real `claude`/`codex` CLI as your user"), `CHANGELOG.md` (`### Changed / added` → `- Codex support: sessions can now run the OpenAI Codex CLI — pick the agent when creating a session. (CODEX_BIN to point at a custom binary.)`)

Steps: cli test first → edits → full `pnpm typecheck && pnpm lint && pnpm test` → Commit `feat(cli,docs): codex env, install preflight, docs`

---

### Task 13: Final verification

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` — all green.
- [ ] `pnpm build` — all packages build.
- [ ] Manual smoke (host has claude, no codex): boot server, `GET /agents` shows codex unavailable, wizard disables Codex, claude session unaffected.
- [ ] Commit any straggler fixes; squash-review the branch diff for stray hardcoded "claude" in touched paths.

## Self-Review

- **Spec coverage:** §1→T5/T6/T7, §2→T1/T2, §3→T4/T7, §4→T6/T7, §5→T7/T8, §6→T9/T10/T11, §7→T12, §8 (errors)→T7, §9 (tests) distributed per task. No gaps.
- **Placeholders:** none — every step names exact files/strings; code given where behavior is non-obvious.
- **Type consistency:** `AgentKind`/`agentFor`/`isAgentKind` (T2) used in T5–T8; `bins: Record<AgentKind, string>` consistent T6/T8; web `AGENTS/EFFORTS_BY_AGENT/...` (T9) consumed in T10/T11.
