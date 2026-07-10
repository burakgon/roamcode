# roamcode — Plan 2: Session Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@roamcode/server` — the layer that spawns and drives the real `claude` CLI: pure argv/config builders, a typed `ClaudeProcess` wrapping one child over stream-json, and an in-memory `SessionManager` for many concurrent sessions — all tested against an interactive mock `claude`, never the real binary.

**Architecture:** A new pnpm workspace package `packages/server` that depends on `@roamcode/protocol` (`workspace:*`) and consumes its `parseLine`/serializers — it never re-implements wire parsing. `config.ts` holds pure functions (`loadConfig`, `buildClaudeArgs`). `claude-process.ts` is an `EventEmitter` that spawns one `claude` child, runs the `initialize → user → hook_callback → control_response → result` lifecycle from `docs/protocol-notes.md`, line-buffers stdout, and re-emits typed events. `session-manager.ts` owns a `Map<id, ClaudeProcess>`. Tests drive a deterministic interactive mock (`test/helpers/mock-claude-interactive.mjs`) that speaks the protocol over stdio, so CI needs no subscription and no network.

**Tech Stack:** Node ≥20 (runtime here is v25.9.0), pnpm workspaces (pnpm 11.8.0), TypeScript 5 (ESM, `verbatimModuleSyntax`), tsup (build), Vitest (test). Child-process orchestration via `node:child_process`.

## Global Constraints

- TypeScript + ESM (`"type":"module"`), Node ≥20, pnpm workspaces. Test: Vitest. Build: tsup.
- **No `ANTHROPIC_API_KEY`** (the spawn env must DELETE it); **no `@anthropic-ai/*` dependency**; subscription auth only. MIT; English.
- All wire-format knowledge stays in `@roamcode/protocol` — `packages/server` consumes it, never re-implements parsing/serialization.
- Tests must NOT depend on the real `claude` binary or network (use the interactive mock); a real-claude smoke test, if any, is opt-in/excluded from CI.
- Follow `docs/protocol-notes.md` exactly; do NOT use `-p`/`--print` (it breaks control round-trips).

### Tooling notes (carried from Plan 1 — read before starting)

- Runtime is Node **v25.9.0**, **pnpm 11.8.0**. `tsconfig.base.json` already sets `composite: true`, `strict`, `noUncheckedIndexedAccess`, **`verbatimModuleSyntax: true`** (so every type-only import MUST use `import type { ... }`), `moduleResolution: "Bundler"`, `target: ES2022`.
- `pnpm test -- <name>` is NOT a reliable Vitest filter. Use `pnpm exec vitest run <path>` for a focused run, `pnpm test` for all.
- New packages add a project reference in the root `tsconfig.json` and extend `../../tsconfig.base.json`.
- The root Vitest config (`vitest.config.ts`) already globs `packages/*/test/**/*.test.ts`, so new server tests are picked up automatically once the package exists.
- `@roamcode/protocol` is already built (`packages/protocol/dist/` exists). After adding the `workspace:*` dependency, run `pnpm install` once so the symlink is created; `import` resolves to its `dist` via the package `exports`.

### Out of scope for Plan 2 (do NOT build — these are Plan 3+)

- Persistence / resume across server restart (SQLite, `--resume`, reading `~/.claude/projects/*.jsonl`). `SessionManager` here is **in-memory only**.
- The WebSocket / REST transport, `auth`, `fs-service`, `push`, and the PWA.
- Idle-session reaping policy. (Sessions live until `stopSession` or process exit.)

---

### Task 1: Package scaffolding + `config.ts` (`loadConfig` + `buildClaudeArgs`)

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/config.ts`
- Create: `packages/server/src/index.ts`
- Modify: `tsconfig.json` (root — add a project reference to `packages/server`)
- Test: `packages/server/test/config.test.ts`

**Canonical shapes:** `docs/protocol-notes.md` → "How `claude` is invoked" (the flag list) and the spec §7 invocation line. Note the spec line shows `-p`; **ignore that** — `protocol-notes.md` overrides it: **no `-p`**.

**Interfaces:**
- Consumes: nothing from earlier server tasks. (Depends on `@roamcode/protocol` via `workspace:*` for later tasks, declared here.)
- Produces (used by `claude-process.ts` and `session-manager.ts` in later tasks):
  - `interface ServerConfig { claudeBin: string; defaultModel?: string; defaultEffort?: string }`.
  - `function loadConfig(env: NodeJS.ProcessEnv): ServerConfig` — pure; reads `CLAUDE_BIN` (default `"claude"`), `CLAUDE_DEFAULT_MODEL`, `CLAUDE_DEFAULT_EFFORT`. Never reads `ANTHROPIC_API_KEY`.
  - `interface BuildClaudeArgsOptions { sessionId: string; model?: string; effort?: string; addDirs?: string[]; dangerouslySkip?: boolean }`.
  - `function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[]` — pure; returns the argv (no binary name, no cwd) per `protocol-notes.md`.

- [ ] **Step 1: Create the package manifest**

`packages/server/package.json`:
```json
{
  "name": "@roamcode/server",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean"
  },
  "dependencies": {
    "@roamcode/protocol": "workspace:*"
  }
}
```

- [ ] **Step 2: Create the package tsconfig**

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../protocol" }]
}
```

- [ ] **Step 3: Add the root project reference**

Replace the contents of `tsconfig.json` (repo root) with:
```json
{
  "files": [],
  "references": [
    { "path": "packages/protocol" },
    { "path": "packages/server" }
  ]
}
```

- [ ] **Step 4: Create a placeholder index so the package resolves**

`packages/server/src/index.ts`:
```ts
export const SERVER_PACKAGE = "@roamcode/server";
export { loadConfig, buildClaudeArgs } from "./config.js";
export type { ServerConfig, BuildClaudeArgsOptions } from "./config.js";
```

- [ ] **Step 5: Install so the workspace symlink is created**

Run:
```bash
pnpm install
```
Expected: completes with `@roamcode/server` now in the workspace; `packages/server/node_modules/@roamcode/protocol` is a symlink. (If pnpm prints `Done`, that is success.)

- [ ] **Step 6: Write the failing test**

`packages/server/test/config.test.ts`:
```ts
import { expect, test } from "vitest";
import { loadConfig, buildClaudeArgs } from "../src/index.js";

test("loadConfig defaults claudeBin to 'claude' and leaves model/effort undefined", () => {
  expect(loadConfig({})).toEqual({ claudeBin: "claude" });
});

test("loadConfig reads CLAUDE_BIN, CLAUDE_DEFAULT_MODEL, CLAUDE_DEFAULT_EFFORT", () => {
  const cfg = loadConfig({
    CLAUDE_BIN: "/opt/claude",
    CLAUDE_DEFAULT_MODEL: "opus",
    CLAUDE_DEFAULT_EFFORT: "high",
  });
  expect(cfg).toEqual({ claudeBin: "/opt/claude", defaultModel: "opus", defaultEffort: "high" });
});

test("loadConfig never surfaces ANTHROPIC_API_KEY", () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: "sk-should-be-ignored" });
  expect(JSON.stringify(cfg)).not.toContain("sk-should-be-ignored");
});

test("buildClaudeArgs always sets the stream-json flag block + session id (remote-approval path)", () => {
  const args = buildClaudeArgs({ sessionId: "sid-1" });
  expect(args).toEqual([
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--session-id", "sid-1",
    "--permission-mode", "default",
  ]);
});

test("buildClaudeArgs uses --dangerously-skip-permissions instead of --permission-mode when dangerouslySkip", () => {
  const args = buildClaudeArgs({ sessionId: "sid-2", dangerouslySkip: true });
  expect(args).toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("--permission-mode");
  expect(args).not.toContain("default");
});

test("buildClaudeArgs never emits both the permission flags together", () => {
  const safe = buildClaudeArgs({ sessionId: "s", dangerouslySkip: false });
  expect(safe.includes("--permission-mode") && safe.includes("--dangerously-skip-permissions")).toBe(false);
  const danger = buildClaudeArgs({ sessionId: "s", dangerouslySkip: true });
  expect(danger.includes("--permission-mode") && danger.includes("--dangerously-skip-permissions")).toBe(false);
});

test("buildClaudeArgs appends optional --effort and --model when provided", () => {
  const args = buildClaudeArgs({ sessionId: "s", model: "opus", effort: "xhigh" });
  expect(args).toContain("--effort");
  expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe("opus");
});

test("buildClaudeArgs repeats --add-dir for each extra directory", () => {
  const args = buildClaudeArgs({ sessionId: "s", addDirs: ["/a", "/b"] });
  const flags = args.filter((a) => a === "--add-dir");
  expect(flags).toHaveLength(2);
  expect(args).toContain("/a");
  expect(args).toContain("/b");
});

test("buildClaudeArgs never includes -p or --print", () => {
  const args = buildClaudeArgs({ sessionId: "s" });
  expect(args).not.toContain("-p");
  expect(args).not.toContain("--print");
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/config.test.ts`
Expected: FAIL — `./config.js` does not exist / `loadConfig` not exported.

- [ ] **Step 8: Write `config.ts`**

`packages/server/src/config.ts`:
```ts
export interface ServerConfig {
  claudeBin: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const config: ServerConfig = { claudeBin: env.CLAUDE_BIN ?? "claude" };
  if (env.CLAUDE_DEFAULT_MODEL) config.defaultModel = env.CLAUDE_DEFAULT_MODEL;
  if (env.CLAUDE_DEFAULT_EFFORT) config.defaultEffort = env.CLAUDE_DEFAULT_EFFORT;
  return config;
}

export interface BuildClaudeArgsOptions {
  sessionId: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  /** When true, spawn with --dangerously-skip-permissions instead of --permission-mode default. */
  dangerouslySkip?: boolean;
}

/**
 * Build the argv for spawning `claude` per docs/protocol-notes.md.
 * Returns flags only — no binary name, no cwd (cwd is the spawn cwd, not an arg).
 * Never includes -p/--print.
 */
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--session-id", opts.sessionId,
  ];

  if (opts.dangerouslySkip) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", "default");
  }

  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.model) args.push("--model", opts.model);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);

  return args;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm exec vitest run packages/server/test/config.test.ts`
Expected: PASS (all config tests).

- [ ] **Step 10: Typecheck the new package wiring**

Run: `pnpm typecheck`
Expected: PASS — the root build references resolve `packages/server` against `packages/protocol`.

- [ ] **Step 11: Commit**

```bash
git add packages/server tsconfig.json pnpm-lock.yaml
git commit -m "feat(server): scaffold package + pure config/buildClaudeArgs (no -p, deletes API key path)"
```

---

### Task 2: Interactive mock `claude` (test harness) + round-trip test

**Files:**
- Create: `packages/server/test/helpers/mock-claude-interactive.mjs`
- Test: `packages/server/test/mock-claude-interactive.test.ts`

**Why:** `ClaudeProcess` (Tasks 3–4) and `SessionManager` (Task 5) must be tested without the real `claude`. This is a deterministic Node script that speaks the protocol over stdin/stdout. It is a **test helper executable** (not shipped in `dist`, not in `package.json` `bin`).

**Canonical shapes:** `docs/protocol-notes.md` — §5a (the `initialize` round-trip), §1 (`system/init`), §2 (`stream_event`), §3 (`assistant`/`user`), §4 (`result`), §5b (`hook_callback` `control_request`), §5c (the accepted `control_response`). The exact envelope rules: `request_id` is **top-level** on a `control_request`; on a `control_response` it is nested at `response.request_id`, discriminator at `response.subtype`, payload at `response.response`.

**Mock behavior (env `MOCK_MODE`):**
- On startup, read stdin line by line.
- When it receives a `control_request` with `request.subtype === "initialize"`: reply with a `control_response` whose `response.request_id` echoes the request's top-level `request_id` and `response.subtype === "success"`, then emit a `system`/`init` line (`session_id: "mock-session"`).
- When it receives a `user` message:
  - `MOCK_MODE=simple` (default): emit two `stream_event`s (a `message_start` and a `content_block_delta` text delta), then an `assistant` text message, then a `result` (`subtype:"success"`). Then exit 0 when stdin closes.
  - `MOCK_MODE=permission`: emit an `assistant` `tool_use` (Write) line, then a `hook_callback` `control_request` (with `callback_id:"hook_0"` and `request.input.{tool_name,tool_input,tool_use_id}`), then **WAIT**. When it then receives a `control_response` (the permission answer): if `response.response.hookSpecificOutput.permissionDecision === "allow"`, emit a `user` `tool_result` line, then a `result` with `permission_denials: []`; if `"deny"`, emit a `result` with one entry in `permission_denials`. Then exit 0 when stdin closes.
- Always: when stdin ends (`end` event), exit 0.
- Unknown / unexpected lines are ignored (do not crash).

**Interfaces:**
- Consumes: nothing from server code (a standalone `.mjs`).
- Produces: an executable script at a path the later tasks reference as `mock-claude-interactive.mjs`; spawned via `node <path>` with `MOCK_MODE` in env.

> **TDD note for this task:** the mock is a hand-authored test *helper*, not a unit under test, so the red→green cycle is inverted from a normal task: write the **test first** (Step 1), run it RED because the helper file does not exist (Step 2), then create the helper (Step 3) and run it GREEN (Step 4). Write the files in that order even though they are listed implementation-first below for readability.

- [ ] **Step 1: Write the failing round-trip test (author this FIRST)**

`packages/server/test/mock-claude-interactive.test.ts`:
```ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseLine, serializeInitialize, serializeUserMessage, serializeHookPermissionResponse, type InboundEvent } from "@roamcode/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

/** Spawn the mock, collect parsed stdout events; on each event run `drive`, finish when `done`. */
function runMock(mode: string, drive: (write: (line: string) => void, events: InboundEvent[]) => void, done: (events: InboundEvent[]) => boolean): Promise<InboundEvent[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_MODE: mode }, stdio: ["pipe", "pipe", "inherit"] });
    const events: InboundEvent[] = [];
    let buffer = "";
    let settled = false;
    const write = (line: string) => child.stdin.write(line + "\n");
    const finish = () => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(events);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const ev = parseLine(line);
        if (!ev) continue;
        events.push(ev);
        drive(write, events);
        if (done(events)) finish();
      }
    });
    child.on("error", reject);
    child.on("exit", finish);
    // kick off the handshake
    write(serializeInitialize({ requestId: "init-test" }));
  });
}

test("mock (simple): initialize -> control_response + init, then user -> result", async () => {
  let sentUser = false;
  const events = await runMock(
    "simple",
    (write, evs) => {
      // After init lands, send a user message exactly once.
      if (!sentUser && evs.some((e) => e.type === "system" && (e as { subtype: string }).subtype === "init")) {
        sentUser = true;
        write(serializeUserMessage("hi"));
      }
    },
    (evs) => evs.some((e) => e.type === "result"),
  );

  expect(events.some((e) => e.type === "control_response" && (e as { requestId?: string }).requestId === "init-test")).toBe(true);
  expect(events.some((e) => e.type === "system" && (e as { subtype: string }).subtype === "init")).toBe(true);
  expect(events.some((e) => e.type === "stream_event")).toBe(true);
  expect(events.some((e) => e.type === "assistant")).toBe(true);
  expect(events.some((e) => e.type === "result")).toBe(true);
});

test("mock (permission): user -> hook_callback, allow -> tool_result + result with empty denials", async () => {
  let sentUser = false;
  let answered = false;
  const events = await runMock(
    "permission",
    (write, evs) => {
      if (!sentUser && evs.some((e) => e.type === "system" && (e as { subtype: string }).subtype === "init")) {
        sentUser = true;
        write(serializeUserMessage("write a file"));
      }
      if (!answered) {
        const req = evs.find((e) => e.type === "control_request" && (e as { subtype: string }).subtype === "hook_callback");
        if (req) {
          answered = true;
          write(serializeHookPermissionResponse((req as { requestId: string }).requestId, "allow", "ok"));
        }
      }
    },
    (evs) => evs.some((e) => e.type === "result"),
  );

  expect(events.some((e) => e.type === "control_request" && (e as { subtype: string }).subtype === "hook_callback")).toBe(true);
  expect(events.some((e) => e.type === "user")).toBe(true);
  const result = events.find((e) => e.type === "result");
  expect(result).toBeTruthy();
  expect((result as { permissionDenials?: unknown[] }).permissionDenials).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/mock-claude-interactive.test.ts`
Expected: FAIL — `./helpers/mock-claude-interactive.mjs` does not exist (spawn ENOENT / no events / timeout).

- [ ] **Step 3: Write the interactive mock**

`packages/server/test/helpers/mock-claude-interactive.mjs`:
```js
#!/usr/bin/env node
// Deterministic interactive mock of `claude` over stream-json stdio.
// Speaks the protocol from docs/protocol-notes.md so tests never need the real binary.
// Mode via env MOCK_MODE: "simple" (default) | "permission".
import { stdin, stdout, env } from "node:process";

const MODE = env.MOCK_MODE ?? "simple";
const SESSION_ID = "mock-session";
const TOOL_USE_ID = "toolu_mock_0001";

function send(obj) {
  stdout.write(JSON.stringify(obj) + "\n");
}

function emitInitResponse(requestId) {
  // control_response: request_id + subtype nested under `response`; payload at response.response.
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { models: [], commands: [], account: { subscriptionType: "Mock" } },
    },
  });
  send({
    type: "system",
    subtype: "init",
    cwd: "/mock/cwd",
    session_id: SESSION_ID,
    tools: ["Write", "Read", "Bash"],
    model: "claude-mock",
    permissionMode: "default",
    apiKeySource: "none",
  });
}

function emitSimpleTurn() {
  send({
    type: "stream_event",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
    session_id: SESSION_ID,
  });
  send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    session_id: SESSION_ID,
  });
  send({
    type: "assistant",
    message: { role: "assistant", model: "claude-mock", content: [{ type: "text", text: "Hello" }] },
    session_id: SESSION_ID,
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Hello",
    session_id: SESSION_ID,
    total_cost_usd: 0,
    permission_denials: [],
  });
}

function emitToolUseAndPermissionRequest() {
  send({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-mock",
      content: [{ type: "tool_use", id: TOOL_USE_ID, name: "Write", input: { file_path: "/mock/cwd/spike.txt", content: "hello\n" } }],
    },
    session_id: SESSION_ID,
  });
  // hook_callback control_request: request_id top-level; tool info under request.input.
  send({
    type: "control_request",
    request_id: "perm-req-0001",
    request: {
      subtype: "hook_callback",
      callback_id: "hook_0",
      tool_use_id: TOOL_USE_ID,
      input: {
        session_id: SESSION_ID,
        cwd: "/mock/cwd",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/mock/cwd/spike.txt", content: "hello\n" },
        tool_use_id: TOOL_USE_ID,
      },
    },
  });
}

function emitPermissionResult(decision) {
  if (decision === "allow") {
    send({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL_USE_ID, content: "File created successfully at: /mock/cwd/spike.txt" }] },
      session_id: SESSION_ID,
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Created spike.txt",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: [],
    });
  } else {
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Write was blocked",
      session_id: SESSION_ID,
      total_cost_usd: 0,
      permission_denials: [{ tool_name: "Write", tool_use_id: TOOL_USE_ID, tool_input: { file_path: "/mock/cwd/spike.txt" } }],
    });
  }
}

let buffer = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed input
    }
    handle(msg);
  }
});
stdin.on("end", () => process.exit(0));

function handle(msg) {
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    emitInitResponse(msg.request_id);
    return;
  }
  if (msg.type === "user") {
    if (MODE === "permission") emitToolUseAndPermissionRequest();
    else emitSimpleTurn();
    return;
  }
  if (msg.type === "control_response") {
    const decision = msg.response?.response?.hookSpecificOutput?.permissionDecision;
    emitPermissionResult(decision === "allow" ? "allow" : "deny");
    return;
  }
  // anything else: ignore
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/mock-claude-interactive.test.ts`
Expected: PASS (both tests). If the permission test hangs, confirm the mock emits the `hook_callback` only after a `user` message and emits a `result` only after the `control_response` — matching `docs/protocol-notes.md` §5b–§5c.

- [ ] **Step 5: Commit**

```bash
git add packages/server/test
git commit -m "test(server): interactive mock claude (stream-json stdio) + round-trip tests"
```

---

### Task 3: `ClaudeProcess` — simple turn (start → send → result → exit)

**Files:**
- Create: `packages/server/src/claude-process.ts`
- Modify: `packages/server/src/index.ts` (export `ClaudeProcess` + types)
- Test: `packages/server/test/claude-process.simple.test.ts`

**Canonical shapes:** `docs/protocol-notes.md` → "How `claude` is invoked", §5a (init handshake + matching the init `control_response` by `request_id`), §4 (`result`), and "Lifecycle" (on `result`, close stdin → child exits). The spawn env must DELETE `ANTHROPIC_API_KEY` (Global Constraints; §3 of the spec).

**Interfaces:**
- Consumes (from Task 1): `buildClaudeArgs`. From `@roamcode/protocol`: `parseLine`, `ProtocolParseError`, `serializeInitialize`, `serializeUserMessage`, `serializeHookPermissionResponse`, `serializeCanUseToolResponse`, `classifyPermissionRequest`, and types `InboundEvent`, `ResultEvent`, `ControlRequestEvent`, `ContentBlock`, `HookPermissionDecision`, `CanUseToolResult`.
- Produces (used by `session-manager.ts` in Task 5):
  - `interface ClaudeProcessOptions { claudeBin: string; cwd: string; sessionId: string; model?: string; effort?: string; addDirs?: string[]; dangerouslySkip?: boolean; startTimeoutMs?: number; env?: NodeJS.ProcessEnv }`.
  - `interface PermissionEvent { requestId: string; kind: "hook_callback" | "can_use_tool"; toolName?: string; toolInput?: unknown; toolUseId?: string }`.
  - `class ClaudeProcess extends EventEmitter` with:
    - `readonly sessionId: string`.
    - `start(): Promise<void>` — spawn, send `initialize`, resolve on the matching init `control_response`, reject on timeout/early exit.
    - `sendUserMessage(content: string | ContentBlock[]): void`.
    - `answerPermission(requestId: string, decision: HookPermissionDecision, reason?: string): void`.
    - `answerCanUseTool(requestId: string, result: CanUseToolResult): void`.
    - `stop(): void`.
  - Typed events (declare via overloaded `on`): `"event"` (`InboundEvent`), `"permission"` (`PermissionEvent`), `"result"` (`ResultEvent`), `"exit"` (`{ code: number | null; signal: NodeJS.Signals | null }`), `"error"` (`Error`).

- [ ] **Step 1: Write the failing test**

`packages/server/test/claude-process.simple.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeProcess } from "../src/index.js";
import type { ResultEvent } from "@roamcode/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makeProc(mode: string) {
  return new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-simple",
    // run the mock script as the "claude binary"
    env: { ...process.env, MOCK_MODE: mode },
    startTimeoutMs: 5000,
  });
}

// We must inject the mock script path as an arg. ClaudeProcess builds argv from buildClaudeArgs,
// so for the test we point claudeBin at node and pass the script via the `scriptArgs` test hook.
test("start() resolves after the init control_response", async () => {
  const proc = makeProc("simple");
  // prepend the mock script so `node <script> <claude args...>` runs the mock
  proc.setSpawnPrefixArgsForTest([MOCK]);
  await proc.start();
  expect(proc.sessionId).toBe("sid-simple");
  proc.stop();
});

test("a simple turn emits assistant + result, then the child exits", async () => {
  const proc = makeProc("simple");
  proc.setSpawnPrefixArgsForTest([MOCK]);
  const events: string[] = [];
  proc.on("event", (e) => events.push(e.type));
  const resultPromise: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;
  const exitPromise = once(proc, "exit");

  await proc.start();
  proc.sendUserMessage("hi");

  const [result] = await resultPromise;
  expect(result.type).toBe("result");
  expect(result.permissionDenials).toEqual([]);

  await exitPromise; // closing stdin on result should let the mock exit
  expect(events).toContain("assistant");
  expect(events).toContain("result");
});

test("malformed stdout lines are skipped, not fatal", async () => {
  const proc = makeProc("simple");
  proc.setSpawnPrefixArgsForTest([MOCK]);
  let errored = false;
  proc.on("error", () => (errored = true));
  await proc.start();
  // The mock never emits malformed lines, but feeding the line buffer a junk line must not throw.
  proc.ingestLineForTest("{not json");
  expect(errored).toBe(false);
  proc.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/claude-process.simple.test.ts`
Expected: FAIL — `ClaudeProcess` not exported.

- [ ] **Step 3: Write `claude-process.ts`**

`packages/server/src/claude-process.ts`:
```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  parseLine,
  serializeInitialize,
  serializeUserMessage,
  serializeHookPermissionResponse,
  serializeCanUseToolResponse,
  classifyPermissionRequest,
  ProtocolParseError,
} from "@roamcode/protocol";
import type {
  InboundEvent,
  ResultEvent,
  ControlRequestEvent,
  ContentBlock,
  HookPermissionDecision,
  CanUseToolResult,
} from "@roamcode/protocol";
import { buildClaudeArgs } from "./config.js";

export interface ClaudeProcessOptions {
  claudeBin: string;
  cwd: string;
  sessionId: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
  /** Milliseconds to wait for the init control_response before rejecting start(). Default 30000. */
  startTimeoutMs?: number;
  /** Base environment to spawn with. ANTHROPIC_API_KEY is always deleted from a copy. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface PermissionEvent {
  requestId: string;
  kind: "hook_callback" | "can_use_tool";
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
}

export class ClaudeProcess extends EventEmitter {
  readonly sessionId: string;
  private readonly opts: ClaudeProcessOptions;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private started = false;
  private initRequestId?: string;
  private spawnPrefixArgs: string[] = [];

  constructor(opts: ClaudeProcessOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId;
  }

  /** TEST ONLY: extra argv inserted before the claude args (used to run the mock script via node). */
  setSpawnPrefixArgsForTest(args: string[]): void {
    this.spawnPrefixArgs = args;
  }

  /** TEST ONLY: push a raw stdout line through the same path the child uses. */
  ingestLineForTest(line: string): void {
    this.handleLine(line);
  }

  start(): Promise<void> {
    if (this.started) throw new Error("ClaudeProcess already started");
    this.started = true;

    const claudeArgs = buildClaudeArgs({
      sessionId: this.opts.sessionId,
      model: this.opts.model,
      effort: this.opts.effort,
      addDirs: this.opts.addDirs,
      dangerouslySkip: this.opts.dangerouslySkip,
    });
    const args = [...this.spawnPrefixArgs, ...claudeArgs];

    // Subscription auth only: never pass an API key to the child.
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(this.opts.claudeBin, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => { /* diagnostics surfaced in a later plan; ignore here */ });
    child.on("error", (err) => this.emit("error", err));
    child.on("exit", (code, signal) => this.emit("exit", { code, signal }));

    const timeoutMs = this.opts.startTimeoutMs ?? 30000;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.stop();
        reject(new Error(`claude did not respond to initialize within ${timeoutMs}ms`));
      }, timeoutMs);

      const onEvent = (ev: InboundEvent) => {
        if (ev.type === "control_response" && ev.requestId === this.initRequestId) {
          cleanup();
          resolve();
        }
      };
      const onEarlyExit = () => {
        cleanup();
        reject(new Error("claude exited before completing the initialize handshake"));
      };
      const onEarlyError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onEarlyExit);
        this.off("error", onEarlyError);
      };
      this.on("event", onEvent);
      this.once("exit", onEarlyExit);
      this.once("error", onEarlyError);

      // Send the initialize handshake (registers the PreToolUse hook).
      this.initRequestId = `init-${this.opts.sessionId}`;
      this.write(serializeInitialize({ requestId: this.initRequestId }));
    });
  }

  sendUserMessage(content: string | ContentBlock[]): void {
    this.write(serializeUserMessage(content));
  }

  answerPermission(requestId: string, decision: HookPermissionDecision, reason?: string): void {
    this.write(serializeHookPermissionResponse(requestId, decision, reason));
  }

  answerCanUseTool(requestId: string, result: CanUseToolResult): void {
    this.write(serializeCanUseToolResponse(requestId, result));
  }

  stop(): void {
    if (this.child && !this.child.killed) this.child.kill();
  }

  private write(line: string): void {
    this.child?.stdin.write(line + "\n");
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let ev: InboundEvent | null;
    try {
      ev = parseLine(line);
    } catch (err) {
      if (err instanceof ProtocolParseError) {
        // Malformed line: log + skip, never crash (spec §10).
        console.warn(`[claude-process ${this.sessionId}] skipping malformed line: ${err.message}`);
        return;
      }
      throw err;
    }
    if (!ev) return;

    this.emit("event", ev);

    if (ev.type === "control_request") {
      const info = classifyPermissionRequest(ev as ControlRequestEvent);
      if (info) {
        const perm: PermissionEvent = {
          requestId: (ev as ControlRequestEvent).requestId,
          kind: info.kind,
          toolName: info.toolName,
          toolInput: info.toolInput,
          toolUseId: info.toolUseId,
        };
        this.emit("permission", perm);
      }
      return;
    }

    if (ev.type === "result") {
      this.emit("result", ev as ResultEvent);
      // Lifecycle: on result, close stdin so the child exits.
      this.child?.stdin.end();
    }
  }
}

// Typed event overloads.
export interface ClaudeProcess {
  on(event: "event", listener: (ev: InboundEvent) => void): this;
  on(event: "permission", listener: (perm: PermissionEvent) => void): this;
  on(event: "result", listener: (result: ResultEvent) => void): this;
  on(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  once(event: "event", listener: (ev: InboundEvent) => void): this;
  once(event: "permission", listener: (perm: PermissionEvent) => void): this;
  once(event: "result", listener: (result: ResultEvent) => void): this;
  once(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  emit(event: "event", ev: InboundEvent): boolean;
  emit(event: "permission", perm: PermissionEvent): boolean;
  emit(event: "result", result: ResultEvent): boolean;
  emit(event: "exit", info: { code: number | null; signal: NodeJS.Signals | null }): boolean;
  emit(event: "error", err: Error): boolean;
}
```

- [ ] **Step 4: Export from index**

Replace `packages/server/src/index.ts` with:
```ts
export const SERVER_PACKAGE = "@roamcode/server";
export { loadConfig, buildClaudeArgs } from "./config.js";
export type { ServerConfig, BuildClaudeArgsOptions } from "./config.js";
export { ClaudeProcess } from "./claude-process.js";
export type { ClaudeProcessOptions, PermissionEvent } from "./claude-process.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/claude-process.simple.test.ts`
Expected: PASS (start resolves; simple turn emits `assistant` + `result`; child exits; malformed line is skipped). If `start()` times out, confirm the mock echoes the init `request_id` back at `response.request_id` and that `initRequestId` equals `init-${sessionId}` (the same value passed to `serializeInitialize`).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src packages/server/test/claude-process.simple.test.ts
git commit -m "feat(server): ClaudeProcess — start handshake, simple turn, result-closes-stdin, malformed-line skip"
```

---

### Task 4: `ClaudeProcess` — permission round-trip

**Files:**
- Test: `packages/server/test/claude-process.permission.test.ts`
- (No source changes expected — `answerPermission` and the `"permission"` event were built in Task 3. If a test reveals a gap, fix `packages/server/src/claude-process.ts`.)

**Canonical shapes:** `docs/protocol-notes.md` §5b (the `hook_callback` `control_request`), §5c (the accepted `control_response` allow shape, payload `{async:false, hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}}`), and "Lifecycle" (answer `hook_callback` → tool runs → `result`).

**Interfaces:**
- Consumes (from Task 3): `ClaudeProcess`, its `"permission"` event (`PermissionEvent`), `answerPermission`, `"result"` (`ResultEvent`).
- Produces: nothing new (this task proves the round-trip).

- [ ] **Step 1: Write the failing test**

`packages/server/test/claude-process.permission.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeProcess, type PermissionEvent } from "../src/index.js";
import type { ResultEvent } from "@roamcode/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makePermissionProc() {
  const proc = new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-perm",
    env: { ...process.env, MOCK_MODE: "permission" },
    startTimeoutMs: 5000,
  });
  proc.setSpawnPrefixArgsForTest([MOCK]);
  return proc;
}

test("permission round-trip: receive 'permission', allow, tool proceeds to result with no denials", async () => {
  const proc = makePermissionProc();
  await proc.start();

  const permPromise: Promise<PermissionEvent[]> = once(proc, "permission") as Promise<PermissionEvent[]>;
  const resultPromise: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;

  proc.sendUserMessage("write a file");

  const [perm] = await permPromise;
  expect(perm.kind).toBe("hook_callback");
  expect(perm.toolName).toBe("Write");
  expect(perm.toolUseId).toBe("toolu_mock_0001");
  expect(typeof perm.requestId).toBe("string");

  proc.answerPermission(perm.requestId, "allow", "approved in test");

  const [result] = await resultPromise;
  expect(result.permissionDenials).toEqual([]);
  proc.stop();
});

test("permission round-trip: deny blocks the tool (result has a denial)", async () => {
  const proc = makePermissionProc();
  await proc.start();

  const permPromise: Promise<PermissionEvent[]> = once(proc, "permission") as Promise<PermissionEvent[]>;
  const resultPromise: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;

  proc.sendUserMessage("write a file");
  const [perm] = await permPromise;
  proc.answerPermission(perm.requestId, "deny", "blocked in test");

  const [result] = await resultPromise;
  expect(Array.isArray(result.permissionDenials)).toBe(true);
  expect((result.permissionDenials ?? []).length).toBe(1);
  proc.stop();
});
```

- [ ] **Step 2: Run test to verify it fails (then passes once correct)**

Run: `pnpm exec vitest run packages/server/test/claude-process.permission.test.ts`
Expected initially: this exercises code from Task 3. If Task 3 is correct it PASSES immediately; if the `"permission"` event or `answerPermission` has a bug it FAILS — fix `packages/server/src/claude-process.ts` until green. (A common failure: the mock waits for the `control_response` before emitting `result`; ensure `answerPermission` writes the line via the child's stdin.)

- [ ] **Step 3: Run the whole server suite to confirm nothing regressed**

Run: `pnpm exec vitest run packages/server`
Expected: PASS (config, mock, claude-process simple + permission).

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/claude-process.permission.test.ts packages/server/src/claude-process.ts
git commit -m "test(server): ClaudeProcess permission round-trip (allow proceeds, deny blocks)"
```

---

### Task 5: `SessionManager` (in-memory, multi-session)

**Files:**
- Create: `packages/server/src/session-manager.ts`
- Modify: `packages/server/src/index.ts` (export `SessionManager` + types)
- Test: `packages/server/test/session-manager.test.ts`

**Canonical shapes:** Same lifecycle as Task 3/4. `SessionManager` is the in-memory owner of `id → ClaudeProcess`. Persistence/resume across restart and the WS/REST transport are **Plan 3** — do not build them here.

**Interfaces:**
- Consumes (from Tasks 1 + 3): `ServerConfig` (Task 1), `ClaudeProcess` + its `setSpawnPrefixArgsForTest`/`start`/`sendUserMessage`/`answerPermission`/`stop` and `"exit"` event (Task 3); from `@roamcode/protocol`: types `ContentBlock`, `HookPermissionDecision`. (The test also imports `PermissionEvent` from the server index and `ResultEvent` from the protocol.)
- Produces:
  - `interface CreateSessionOptions { cwd: string; model?: string; effort?: string; addDirs?: string[]; dangerouslySkip?: boolean }`.
  - `interface Session { id: string; cwd: string; process: ClaudeProcess }`.
  - `class SessionManager`:
    - `constructor(config: ServerConfig, deps?: { spawnPrefixArgs?: string[]; baseEnv?: NodeJS.ProcessEnv; startTimeoutMs?: number })` — `deps` exists so tests can point at the mock; production passes no `deps`.
    - `createSession(opts: CreateSessionOptions): Promise<Session>` — generate a UUID via `node:crypto.randomUUID()`, construct a `ClaudeProcess`, `await start()`, store it, return the `Session`.
    - `getSession(id: string): Session | undefined`.
    - `listSessions(): Session[]`.
    - `sendMessage(id: string, content: string | ContentBlock[]): void` — throws if unknown id.
    - `answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): void` — throws if unknown id.
    - `stopSession(id: string): void` — stops the process and removes it from the map.

- [ ] **Step 1: Write the failing test**

`packages/server/test/session-manager.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { SessionManager } from "../src/index.js";
import type { PermissionEvent } from "../src/index.js";
import type { ResultEvent } from "@roamcode/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function managerFor(mode: string) {
  return new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: mode }, startTimeoutMs: 5000 },
  );
}

test("createSession spawns a started process with a generated UUID", async () => {
  const mgr = managerFor("simple");
  const session = await mgr.createSession({ cwd: process.cwd() });
  expect(session.id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  expect(session.cwd).toBe(process.cwd());
  expect(mgr.getSession(session.id)).toBe(session);
  expect(mgr.listSessions()).toHaveLength(1);
  mgr.stopSession(session.id);
});

test("sendMessage drives a full turn to result", async () => {
  const mgr = managerFor("simple");
  const session = await mgr.createSession({ cwd: process.cwd() });
  const resultPromise: Promise<ResultEvent[]> = once(session.process, "result") as Promise<ResultEvent[]>;
  mgr.sendMessage(session.id, "hi");
  const [result] = await resultPromise;
  expect(result.type).toBe("result");
  mgr.stopSession(session.id);
});

test("two concurrent sessions are independent", async () => {
  const mgr = managerFor("simple");
  const a = await mgr.createSession({ cwd: process.cwd() });
  const b = await mgr.createSession({ cwd: process.cwd() });
  expect(a.id).not.toBe(b.id);
  expect(mgr.listSessions().map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

  const ra: Promise<ResultEvent[]> = once(a.process, "result") as Promise<ResultEvent[]>;
  const rb: Promise<ResultEvent[]> = once(b.process, "result") as Promise<ResultEvent[]>;
  mgr.sendMessage(a.id, "hi a");
  mgr.sendMessage(b.id, "hi b");
  await Promise.all([ra, rb]);

  mgr.stopSession(a.id);
  mgr.stopSession(b.id);
});

test("answerPermission routes to the right session", async () => {
  const mgr = managerFor("permission");
  const session = await mgr.createSession({ cwd: process.cwd() });
  const permPromise: Promise<PermissionEvent[]> = once(session.process, "permission") as Promise<PermissionEvent[]>;
  const resultPromise: Promise<ResultEvent[]> = once(session.process, "result") as Promise<ResultEvent[]>;
  mgr.sendMessage(session.id, "write a file");
  const [perm] = await permPromise;
  mgr.answerPermission(session.id, perm.requestId, "allow", "ok");
  const [result] = await resultPromise;
  expect(result.permissionDenials).toEqual([]);
  mgr.stopSession(session.id);
});

test("stopSession removes the session; unknown ids throw", async () => {
  const mgr = managerFor("simple");
  const session = await mgr.createSession({ cwd: process.cwd() });
  mgr.stopSession(session.id);
  expect(mgr.getSession(session.id)).toBeUndefined();
  expect(mgr.listSessions()).toHaveLength(0);
  expect(() => mgr.sendMessage("nope", "x")).toThrow();
  expect(() => mgr.answerPermission("nope", "r", "allow")).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/session-manager.test.ts`
Expected: FAIL — `SessionManager` not exported.

- [ ] **Step 3: Write `session-manager.ts`**

`packages/server/src/session-manager.ts`:
```ts
import { randomUUID } from "node:crypto";
import { ClaudeProcess } from "./claude-process.js";
import type { ServerConfig } from "./config.js";
import type { ContentBlock, HookPermissionDecision } from "@roamcode/protocol";

export interface CreateSessionOptions {
  cwd: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
}

export interface Session {
  id: string;
  cwd: string;
  process: ClaudeProcess;
}

/** Test-only injection so the manager can drive the interactive mock instead of the real binary. */
export interface SessionManagerDeps {
  spawnPrefixArgs?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
}

export class SessionManager {
  private readonly config: ServerConfig;
  private readonly deps: SessionManagerDeps;
  private readonly sessions = new Map<string, Session>();

  constructor(config: ServerConfig, deps: SessionManagerDeps = {}) {
    this.config = config;
    this.deps = deps;
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    const id = randomUUID();
    const proc = new ClaudeProcess({
      claudeBin: this.config.claudeBin,
      cwd: opts.cwd,
      sessionId: id,
      model: opts.model ?? this.config.defaultModel,
      effort: opts.effort ?? this.config.defaultEffort,
      addDirs: opts.addDirs,
      dangerouslySkip: opts.dangerouslySkip,
      startTimeoutMs: this.deps.startTimeoutMs,
      env: this.deps.baseEnv,
    });
    if (this.deps.spawnPrefixArgs) proc.setSpawnPrefixArgsForTest(this.deps.spawnPrefixArgs);

    // Drop a dead session from the map automatically.
    proc.on("exit", () => {
      this.sessions.delete(id);
    });

    await proc.start();
    const session: Session = { id, cwd: opts.cwd, process: proc };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  sendMessage(id: string, content: string | ContentBlock[]): void {
    this.require(id).process.sendUserMessage(content);
  }

  answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): void {
    this.require(id).process.answerPermission(requestId, decision, reason);
  }

  stopSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.process.stop();
    this.sessions.delete(id);
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }
}
```

- [ ] **Step 4: Export from index**

Replace `packages/server/src/index.ts` with:
```ts
export const SERVER_PACKAGE = "@roamcode/server";
export { loadConfig, buildClaudeArgs } from "./config.js";
export type { ServerConfig, BuildClaudeArgsOptions } from "./config.js";
export { ClaudeProcess } from "./claude-process.js";
export type { ClaudeProcessOptions, PermissionEvent } from "./claude-process.js";
export { SessionManager } from "./session-manager.js";
export type { CreateSessionOptions, Session, SessionManagerDeps } from "./session-manager.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/session-manager.test.ts`
Expected: PASS (create with UUID, full turn, two concurrent independent sessions, permission routing, stop + unknown-id throws).

- [ ] **Step 6: Run the entire repo suite + typecheck + build**

Run:
```bash
pnpm test
pnpm typecheck
pnpm -C packages/server build
```
Expected: all PASS. `pnpm test` runs both `protocol` and `server` suites. The build emits `packages/server/dist/index.js` + `index.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src packages/server/test/session-manager.test.ts
git commit -m "feat(server): in-memory SessionManager (create/list/get/send/answer/stop) over the mock"
```

---

## Self-Review

**1. Spec coverage (vs the prompt's scope, the spec §3/§6/§7/§8/§9, and `docs/protocol-notes.md`):**
- Package scaffolding + `config.ts` (`loadConfig` + `buildClaudeArgs`) → **Task 1**. `buildClaudeArgs` always emits `--input-format stream-json --output-format stream-json --verbose --include-partial-messages --include-hook-events --session-id <uuid>`, then EITHER `--permission-mode default` OR `--dangerously-skip-permissions` (never both), plus optional `--effort`/`--model`/repeated `--add-dir`; no `-p`/`--print`; cwd is not an arg. Tested thoroughly (9 cases). ✓
- Interactive mock claude over stdin/stdout, mode via env, init→system/init, simple vs permission, waits for the `control_response` → **Task 2**, with a round-trip test. ✓
- `ClaudeProcess` (typed EventEmitter): `start()` (spawn with `buildClaudeArgs` + cwd + env with `ANTHROPIC_API_KEY` deleted; send `serializeInitialize`; resolve on the matching init `control_response` with a timeout), `sendUserMessage`, `answerPermission`, `stop()`; line-buffers stdout, `parseLine`s, emits `"event"`/`"permission"`/`"result"`/`"exit"`/`"error"`; on `result` closes stdin; malformed lines logged + skipped → **Task 3** (simple turn) + **Task 4** (permission round-trip). ✓
- `SessionManager` in-memory: `createSession` (UUID + `start()`), `getSession`, `listSessions`, `sendMessage`, `answerPermission`, `stopSession`; `Map<id, ClaudeProcess>`; concurrent sessions covered → **Task 5**. ✓
- No `ANTHROPIC_API_KEY` (deleted in `start()`), no `@anthropic-ai/*` dep (only `@roamcode/protocol` in `package.json`), subscription auth only → Global Constraints + Task 1/3. ✓
- Wire-format knowledge stays in `@roamcode/protocol` (server imports `parseLine`/serializers/`classifyPermissionRequest`, never re-parses) → Tasks 3–5. ✓
- Tests never need the real `claude` or network (interactive mock); no real-claude smoke test added (explicitly opt-in/excluded — noted, none included) → Tasks 2–5. ✓
- Persistence/resume + WS/REST transport explicitly OUT of scope → "Out of scope" callout + Task 5 note. ✓
- Right-sized to 5 tasks (ClaudeProcess split into Task 3 simple + Task 4 permission, as permitted). ✓

**2. Placeholder scan:** No "TBD/TODO/implement later". Every code step shows the complete file/edit. The only deliberate phrasing is the `stderr` handler comment ("surfaced in a later plan; ignore here") — that is a real, intentional no-op for this plan's scope, not a placeholder. ✓

**3. Type consistency (names/signatures across tasks):**
- `ServerConfig`, `loadConfig`, `BuildClaudeArgsOptions`, `buildClaudeArgs` — defined Task 1, consumed Tasks 3 & 5. ✓
- `ClaudeProcess`, `ClaudeProcessOptions`, `PermissionEvent` — defined Task 3, consumed Tasks 4 & 5; the test hooks `setSpawnPrefixArgsForTest`/`ingestLineForTest` are referenced by the same names in Tasks 3, 5. ✓
- `start`/`sendUserMessage`/`answerPermission`/`answerCanUseTool`/`stop` and events `"event"`/`"permission"`/`"result"`/`"exit"`/`"error"` — consistent across Tasks 3–5. ✓
- `SessionManager`, `CreateSessionOptions`, `Session`, `SessionManagerDeps` — defined Task 5, exported from index. ✓
- Protocol names used exactly as exported (`parseLine`, `ProtocolParseError`, `serializeInitialize`, `serializeUserMessage`, `serializeHookPermissionResponse`, `serializeCanUseToolResponse`, `classifyPermissionRequest`; types `InboundEvent`, `ResultEvent`, `ControlRequestEvent`, `ContentBlock`, `HookPermissionDecision`, `CanUseToolResult`) — verified against `packages/protocol/src/index.ts`. ✓
- `import type` used for all type-only imports (required by `verbatimModuleSyntax: true`). ✓

---

## Notes carried to Plan 3 (transport / persistence)

- `ClaudeProcess` already emits a generic `"event"` for every `InboundEvent` — Plan 3's WS hub can subscribe to that for the per-session broadcast + replay buffer (spec §10), and to `"permission"`/`"result"` for prompts and turn-completion (Web Push).
- The `setSpawnPrefixArgsForTest` / `ingestLineForTest` / `SessionManagerDeps` hooks exist purely for the mock; production code constructs `ClaudeProcess`/`SessionManager` without them. Plan 3 should keep using the interactive mock for transport integration tests.
- Resume (`claude --resume <session-id>`), idle reaping, SQLite registry, and reading `~/.claude/projects/*.jsonl` are deferred to Plan 3 per the spec §8.
- A `stderr` diagnostics channel is currently a no-op in `ClaudeProcess`; Plan 3 should surface it (spec §10: "auth expired → re-login on the host").
