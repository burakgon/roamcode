# roamcode — Plan 3: Live Server API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@roamcode/server` a live, self-hostable headless server — `claude` sessions run keep-alive (multi-turn on one process), are driven over a token-protected HTTP + WebSocket API (REST for session/file management, WS per session for the live event stream + inbound user messages and permission answers), with a per-session reconnect replay buffer — all tested against the interactive mock and localhost only.

**Architecture:** Plan 2 already built the in-memory `SessionManager` over `ClaudeProcess`. Plan 3 first evolves `ClaudeProcess` so a single child serves many turns (drop `stdin.end()` on `result`; close stdin only in `stop()`; guard writes after teardown) and adds a `"diagnostic"` event carrying stderr/malformed-line notices. It then adds pure, independently-tested units — `loadServerConfig` (port/bind/token/defaults), an `AuthGate` (constant-time token check + lockout), an `FsService` (guarded directory listing + file read/write), and a `ReplayBuffer` ring (never drops `permission`/`result`) — and a `SessionHub` that attaches to `ClaudeProcess` events, fans them out to per-session subscribers, and feeds each session's replay buffer. Finally `createServer(config, sessionManager)` returns a Fastify instance wiring REST + a per-session WebSocket route through `AuthGate`, and an entry point starts it. Transport uses **Fastify** + `@fastify/websocket` + `@fastify/multipart` (not the Agent SDK). All wire-format knowledge stays in `@roamcode/protocol`.

**Tech Stack:** Node ≥20 (runtime here is v25.9.0), pnpm workspaces (pnpm 11.8.0), TypeScript 5 (ESM, `verbatimModuleSyntax`), tsup (build), Vitest (test). Transport: Fastify 5 + `@fastify/websocket` + `@fastify/multipart`. Child-process orchestration via `node:child_process`.

## Global Constraints

- TypeScript + ESM (`"type":"module"`), Node ≥20, pnpm workspaces. Test: Vitest. Build: tsup. `tsconfig.base.json` sets `composite`, `strict`, `noUncheckedIndexedAccess`, and **`verbatimModuleSyntax: true`** → every type-only import MUST use `import type { ... }`.
- **No `ANTHROPIC_API_KEY`** (the spawn env DELETES it — already done in `ClaudeProcess.start()`); **no `@anthropic-ai/*` dependency**; subscription auth only. MIT; English.
- All wire-format knowledge stays in `@roamcode/protocol` — `packages/server` consumes its `parseLine`/serializers/`classifyPermissionRequest`, never re-implements parsing/serialization.
- Tests must NOT depend on the real `claude` binary or any external network. Use the interactive mock (`packages/server/test/helpers/mock-claude-interactive.mjs`) and bind HTTP/WS to `127.0.0.1` only. A real-`claude` smoke test, if any, is opt-in and excluded from CI.
- Follow `docs/protocol-notes.md` exactly; do NOT use `-p`/`--print` (it breaks control round-trips). Keep-alive is confirmed viable (see `docs/protocol-notes.md` → "Multi-turn (one process, multiple turns)").
- **Security (spec §9) — what THIS plan delivers vs defers (read carefully; do not assume §9 is fully done):**
  - **Delivered here (enforcement):** the server **refuses to start** when bound to a non-loopback address with no token (Task 3/11); the token is compared in **constant time** (`timingSafeEqual`, Task 4); a single global preHandler gates **both** REST and the **WS upgrade** handshake (Task 8); per-client failure **lockout** (Task 4, with the proxy caveat below).
  - **Intentionally allowed:** a **loopback/dev run with NO token is permitted** (tokenless) — the preHandler allows requests when `config.accessToken` is unset, and `assertConfigAllowsStart` only blocks the *non-loopback* tokenless case. This is by design for `127.0.0.1` development.
  - **Deferred to Plan 4 (token generation + persistence):** spec §9's "a long random secret **generated on first run** (printed once, stored)" is **NOT** implemented here — generation/printing/persisting the token couples to the SQLite/storage layer (Plan 4). This plan only *consumes* a token supplied via `ACCESS_TOKEN`. So §9 is **partially delivered** (enforcement) and **completed in Plan 4** (generation/persistence). Do not claim §9 is fully done.
  - `--dangerously-skip-permissions` is a per-session opt-in (already threaded through `buildClaudeArgs`).
- Fastify deps go in `packages/server/package.json`; `pnpm install` runs in the first task that adds them (Task 8).
- **Test typing caveat (pre-existing):** test files (`packages/*/test/**/*.test.ts`) are validated by **Vitest execution**, not by `tsc -b` (the package `tsconfig.build.json`/`include` covers `src` only). A type error that lives solely in a test surfaces when the test runs, not in `pnpm typecheck`.

### Tooling notes (carried from Plans 1–2 — read before starting)

- Runtime is Node **v25.9.0**, **pnpm 11.8.0**. `pnpm test -- <name>` is NOT a reliable Vitest filter — use `pnpm exec vitest run <path>` for a focused run, `pnpm test` for all. `pnpm typecheck` runs `tsc -b`. `pnpm -C packages/server build` runs tsup with `tsconfig.build.json` (a non-composite build config: `packages/server/tsconfig.build.json` already exists and extends `tsconfig.json` with `composite:false, incremental:false`).
- The root `vitest.config.ts` globs `packages/*/test/**/*.test.ts` (new server tests are picked up automatically) and aliases `@roamcode/protocol` → its `src` (tests need no prebuild). `packages/server` is NOT imported by other packages' tests in this plan, so **no new Vitest alias is required**.
- `@roamcode/protocol` is already built and symlinked into `packages/server/node_modules`. The real exported names this plan depends on (verified in `packages/protocol/src/index.ts`):
  - functions: `parseLine`, `ProtocolParseError`, `buildImageBlock`, `serializeUserMessage`, `serializeInitialize`, `serializeHookPermissionResponse`, `serializeCanUseToolResponse`, `classifyPermissionRequest`.
  - types: `InboundEvent`, `SystemEvent`, `StreamEvent`, `AssistantEvent`, `UserEvent`, `ResultEvent`, `ControlRequestEvent`, `ControlResponseEvent`, `RateLimitEvent`, `UnknownEvent`, `ContentBlock`, `TextBlock`, `ImageBlock`, `HookPermissionDecision`, `CanUseToolResult`.
- Existing `packages/server` exports (verified in `packages/server/src/index.ts`): `loadConfig`, `buildClaudeArgs`, `ServerConfig`, `BuildClaudeArgsOptions`, `ClaudeProcess`, `ClaudeProcessOptions`, `PermissionEvent`, `SessionManager`, `CreateSessionOptions`, `Session`, `SessionManagerDeps`.

### Out of scope for Plan 3 (do NOT build — these are later plans)

- **Plan 4:** persistence/resume across server restart (SQLite, `claude --resume <id>`, reading `~/.claude/projects/*.jsonl` for full history) and Web Push. `SessionManager` stays **in-memory**; multi-turn now works *within* a live session, but a dead/restarted process is not respawned here. "Session history" in this plan = the in-memory replay buffer only.
- **Plan 4 — `POST /sessions` idempotency (spec §10 "idempotency guard on session create").** NOT implemented here. A correct idempotency-key dedupe must remember keys → created session ids across requests *and* server restarts, which couples to the persistent session registry (SQLite) that Plan 4 introduces; an in-memory-only guard would silently stop working after a restart and give a false sense of safety. Deferred to Plan 4 (add an `Idempotency-Key` header → registry-backed dedupe). Called out explicitly so its absence here is intentional, not an oversight. Until then, `POST /sessions` is not idempotent: a retried create spawns a second session.
- **Plan 5:** the PWA (React/Vite frontend).
- **Plan 6:** distribution (`npx`, Docker, Caddy), README/docs, CI.
- Idle-session reaping policy (sessions live until `stopSession` or process exit).

---

### Task 1: `ClaudeProcess` keep-alive (multi-turn) + write-after-teardown guard

**Files:**
- Modify: `packages/server/src/claude-process.ts`
- Test: `packages/server/test/claude-process.multiturn.test.ts` (create)

**Canonical shapes:** `docs/protocol-notes.md` → "Multi-turn (one process, multiple turns)" (keep-alive is VIABLE: after the first `result` do NOT close stdin; write the next `user` line and a second turn runs on the same process/session; close stdin only on teardown) and "Lifecycle" (the "close stdin on result" step is dropped, gated on teardown instead).

**Interfaces:**
- Consumes: nothing new. (Builds on Plan 2's `ClaudeProcess`.)
- Produces (the contract later tasks rely on):
  - `ClaudeProcess.sendUserMessage(content)` may now be called **multiple times** on one started process; each call runs a turn that ends with a `"result"` event. The process stays alive between turns.
  - `ClaudeProcess.stop()` is the ONLY place stdin is closed (it ends stdin, then kills the child).
  - `ClaudeProcess.write()` (private) is guarded: it no-ops and emits an `"error"` (an `Error` whose message contains `"write after teardown"`) if called when the child's stdin is not writable — it never throws/crashes.

- [ ] **Step 1: Write the failing multi-turn + write-after-stop test**

`packages/server/test/claude-process.multiturn.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeProcess } from "../src/index.js";
import type { ResultEvent } from "@roamcode/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makeProc() {
  const proc = new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-multiturn",
    env: { ...process.env, MOCK_MODE: "simple" },
    startTimeoutMs: 5000,
  });
  proc.setSpawnPrefixArgsForTest([MOCK]);
  return proc;
}

test("two turns run on ONE keep-alive process (no exit between turns)", async () => {
  const proc = makeProc();
  let exited = false;
  proc.on("exit", () => (exited = true));
  await proc.start();

  // Turn 1.
  const r1: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;
  proc.sendUserMessage("first");
  const [result1] = await r1;
  expect(result1.type).toBe("result");
  expect(exited).toBe(false); // the process must NOT exit after turn 1

  // Turn 2 on the SAME process — proves stdin stayed open.
  const r2: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;
  proc.sendUserMessage("second");
  const [result2] = await r2;
  expect(result2.type).toBe("result");
  expect(exited).toBe(false);

  // Teardown closes stdin -> the mock exits cleanly.
  const exitPromise = once(proc, "exit");
  proc.stop();
  await exitPromise;
});

test("write after stop() does not crash; it surfaces a clear error", async () => {
  const proc = makeProc();
  await proc.start();
  const exitPromise = once(proc, "exit");
  proc.stop();
  await exitPromise;

  let err: Error | undefined;
  proc.on("error", (e) => (err = e));
  // Must not throw synchronously, and must not crash the process.
  expect(() => proc.sendUserMessage("too late")).not.toThrow();
  expect(err).toBeInstanceOf(Error);
  expect(err?.message).toContain("write after teardown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/claude-process.multiturn.test.ts`
Expected: FAIL — turn 1 currently closes stdin on `result`, so the second turn never produces a `result` (test times out or `exited` becomes `true`), and `sendUserMessage` after `stop()` currently calls `this.child?.stdin.write(...)` on an ended stream (throws / no clear error).

- [ ] **Step 3: Drop the result-closes-stdin step**

In `packages/server/src/claude-process.ts`, find the `handleLine` `result` branch:
```ts
    if (ev.type === "result") {
      this.emit("result", ev as ResultEvent);
      // Lifecycle: on result, close stdin so the child exits.
      this.child?.stdin.end();
    }
```
Replace it with (keep emitting `"result"`; do NOT close stdin — the process serves the next turn):
```ts
    if (ev.type === "result") {
      // Multi-turn keep-alive: `result` only marks turn completion. The process
      // stays alive for the next sendUserMessage; stdin is closed only in stop().
      this.emit("result", ev as ResultEvent);
    }
```

- [ ] **Step 4: Close stdin in `stop()` and guard `write()`**

In the same file, replace the `stop()` and `write()` methods:
```ts
  stop(): void {
    if (this.child && !this.child.killed) this.child.kill();
  }

  private write(line: string): void {
    this.child?.stdin.write(line + "\n");
  }
```
with:
```ts
  stop(): void {
    if (!this.child || this.child.killed) return;
    // Keep-alive teardown: close stdin first so the child can exit cleanly, then kill.
    if (this.child.stdin.writable) this.child.stdin.end();
    this.child.kill();
  }

  private write(line: string): void {
    if (!this.child || !this.child.stdin.writable) {
      // Write after teardown: surface a clear error, never crash (spec §10).
      this.emit("error", new Error(`write after teardown (session ${this.sessionId})`));
      return;
    }
    this.child.stdin.write(line + "\n");
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/claude-process.multiturn.test.ts`
Expected: PASS (both turns produce a `result` on one process; no exit between turns; write after `stop()` emits an `Error` containing `"write after teardown"` without throwing). If turn 2 still times out, confirm Step 3 removed the `stdin.end()` call. If the test process hangs on exit, confirm `stop()` calls `child.kill()` after `stdin.end()`.

- [ ] **Step 6: Fix the Plan 2 simple-turn test that relied on result-closing-stdin**

`packages/server/test/claude-process.simple.test.ts` has a test "a simple turn emits assistant + result, then the child exits" that does `await exitPromise` **without** calling `proc.stop()` first — it relied on the now-removed `stdin.end()`-on-`result` to make the mock exit. With keep-alive it would hang forever. In that file, find:
```ts
  const [result] = await resultPromise;
  expect(result.type).toBe("result");
  expect(result.permissionDenials).toEqual([]);

  await exitPromise; // closing stdin on result should let the mock exit
  expect(events).toContain("assistant");
  expect(events).toContain("result");
});
```
and replace it with (assert the events first, then `stop()` to close stdin so the mock exits):
```ts
  const [result] = await resultPromise;
  expect(result.type).toBe("result");
  expect(result.permissionDenials).toEqual([]);

  expect(events).toContain("assistant");
  expect(events).toContain("result");

  // Keep-alive: the process does NOT exit on result. stop() closes stdin -> the mock exits.
  proc.stop();
  await exitPromise;
});
```

- [ ] **Step 7: Confirm the rest of the Plan 2 server suite still passes**

Run: `pnpm exec vitest run packages/server`
Expected: PASS for `config`, `mock-claude-interactive`, `claude-process.simple` (with the Step 6 fix), `claude-process.permission`, `session-manager`, and the new `multiturn`. Note: `claude-process.simple.test.ts`'s "malformed stdout lines are skipped" test currently spies on `console.warn` — that test is fixed in **Task 2 Step 2a** (it must move to asserting a `"diagnostic"` event). Until then it still passes because Task 1 does not touch the `console.warn` line.

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add packages/server/src/claude-process.ts packages/server/test/claude-process.simple.test.ts packages/server/test/claude-process.multiturn.test.ts
git commit -m "feat(server): ClaudeProcess keep-alive multi-turn + write-after-teardown guard"
```

---

### Task 2: `ClaudeProcess` diagnostics channel (`"diagnostic"` event)

**Files:**
- Modify: `packages/server/src/claude-process.ts`
- Test: `packages/server/test/claude-process.diagnostic.test.ts` (create)

**Canonical shapes:** spec §10 — "stderr captured → surfaced as diagnostics (e.g., 'auth expired → re-login on the host')" and "Malformed stream-json line → log + skip; the parser never crashes the server." This task replaces the bare `console.warn` for malformed lines and the no-op stderr handler with a typed `"diagnostic"` event (decouples tests from `console`).

**Interfaces:**
- Consumes (from Task 1): the updated `ClaudeProcess`.
- Produces (the contract later tasks rely on):
  - `interface DiagnosticEvent { source: "stderr" | "parser"; message: string }`.
  - `ClaudeProcess` emits `"diagnostic"` (a `DiagnosticEvent`) for each captured stderr line and for each malformed stdout line (instead of `console.warn`). Malformed lines are still skipped, never fatal.
  - Exported from the package index: `DiagnosticEvent`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/claude-process.diagnostic.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeProcess } from "../src/index.js";
import type { DiagnosticEvent } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makeProc(mode = "simple") {
  const proc = new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-diag",
    env: { ...process.env, MOCK_MODE: mode },
    startTimeoutMs: 5000,
  });
  proc.setSpawnPrefixArgsForTest([MOCK]);
  return proc;
}

test("malformed stdout line emits a parser diagnostic, not a crash", async () => {
  const proc = makeProc();
  const diags: DiagnosticEvent[] = [];
  proc.on("diagnostic", (d) => diags.push(d));
  let errored = false;
  proc.on("error", () => (errored = true));
  await proc.start();

  proc.ingestLineForTest("{not valid json");

  expect(errored).toBe(false);
  expect(diags.some((d) => d.source === "parser")).toBe(true);
  proc.stop();
});

test("stderr from the child surfaces as a stderr diagnostic", async () => {
  const proc = makeProc("stderr"); // a mock mode that writes one stderr line
  const diagPromise: Promise<DiagnosticEvent[]> = once(proc, "diagnostic") as Promise<DiagnosticEvent[]>;
  await proc.start();
  const [diag] = await diagPromise;
  expect(diag.source).toBe("stderr");
  expect(diag.message).toContain("auth expired");
  proc.stop();
});
```

- [ ] **Step 2: Add a `stderr` mode to the interactive mock**

The second test needs the mock to emit a stderr line. In `packages/server/test/helpers/mock-claude-interactive.mjs`, find the `emitInitResponse` function call site inside `handle` — specifically the `initialize` branch:
```js
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    emitInitResponse(msg.request_id);
    return;
  }
```
Replace it with (emit one stderr line right after init when `MOCK_MODE=stderr`; behaviour for `simple`/`permission` is unchanged):
```js
  if (msg.type === "control_request" && msg.request?.subtype === "initialize") {
    emitInitResponse(msg.request_id);
    if (MODE === "stderr") {
      process.stderr.write("auth expired → re-login on the host\n");
    }
    return;
  }
```

- [ ] **Step 2a: Migrate the Plan 2 malformed-line test off `console.warn`**

`packages/server/test/claude-process.simple.test.ts` has a "malformed stdout lines are skipped" test that spies on `console.warn` and asserts it was called. This task removes the `console.warn` (Step 4 routes malformed lines through the `"diagnostic"` event), so that assertion will break. In that file, find:
```ts
test("malformed stdout lines are skipped, not fatal", async () => {
  const proc = makeProc("simple");
  proc.setSpawnPrefixArgsForTest([MOCK]);
  let errored = false;
  proc.on("error", () => (errored = true));
  await proc.start();
  // The mock never emits malformed lines, but feeding the line buffer a junk line must not throw.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  proc.ingestLineForTest("{not json");
  expect(warn).toHaveBeenCalled();
  expect(errored).toBe(false);
  warn.mockRestore();
  proc.stop();
});
```
and replace it with (assert a `"diagnostic"` event instead of a `console.warn` call):
```ts
test("malformed stdout lines are skipped, not fatal", async () => {
  const proc = makeProc("simple");
  proc.setSpawnPrefixArgsForTest([MOCK]);
  let errored = false;
  const diags: { source: string; message: string }[] = [];
  proc.on("error", () => (errored = true));
  proc.on("diagnostic", (d) => diags.push(d));
  await proc.start();
  // The mock never emits malformed lines, but feeding the line buffer a junk line must not throw.
  proc.ingestLineForTest("{not json");
  expect(diags.some((d) => d.source === "parser")).toBe(true);
  expect(errored).toBe(false);
  proc.stop();
});
```
Then remove the now-unused `vi` import — change the first import line from:
```ts
import { expect, test, vi } from "vitest";
```
to:
```ts
import { expect, test } from "vitest";
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/claude-process.diagnostic.test.ts`
Expected: FAIL — `DiagnosticEvent` is not exported and `ClaudeProcess` does not emit `"diagnostic"`.

- [ ] **Step 4: Add the `DiagnosticEvent` type + emit from stderr and the parser**

In `packages/server/src/claude-process.ts`, add the interface right after `PermissionEvent`:
```ts
export interface DiagnosticEvent {
  source: "stderr" | "parser";
  message: string;
}
```

In `start()`, replace the stderr handler:
```ts
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => { /* diagnostics surfaced in a later plan; ignore here */ });
```
with a line-buffered stderr handler that emits diagnostics:
```ts
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderrChunk(chunk));
```

Add a private `stderrBuffer` field next to `stdoutBuffer`:
```ts
  private stdoutBuffer = "";
```
becomes:
```ts
  private stdoutBuffer = "";
  private stderrBuffer = "";
```

Add the `onStderrChunk` method (place it just after `onStdoutChunk`):
```ts
  private onStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;
    let nl: number;
    while ((nl = this.stderrBuffer.indexOf("\n")) !== -1) {
      const line = this.stderrBuffer.slice(0, nl);
      this.stderrBuffer = this.stderrBuffer.slice(nl + 1);
      if (line.trim()) this.emit("diagnostic", { source: "stderr", message: line });
    }
  }
```

In `handleLine`, replace the malformed-line branch:
```ts
      if (err instanceof ProtocolParseError) {
        // Malformed line: log + skip, never crash (spec §10).
        console.warn(`[claude-process ${this.sessionId}] skipping malformed line: ${err.message}`);
        return;
      }
```
with (route through the diagnostic channel instead of `console.warn`):
```ts
      if (err instanceof ProtocolParseError) {
        // Malformed line: surface as a diagnostic + skip, never crash (spec §10).
        this.emit("diagnostic", { source: "parser", message: err.message });
        return;
      }
```

- [ ] **Step 5: Add typed event overloads for `"diagnostic"`**

In the `export interface ClaudeProcess { ... }` block at the bottom, add three lines (one each to the `on`, `once`, `emit` groups). After the `on(event: "result", ...)` line add:
```ts
  on(event: "diagnostic", listener: (diag: DiagnosticEvent) => void): this;
```
After the `once(event: "result", ...)` line add:
```ts
  once(event: "diagnostic", listener: (diag: DiagnosticEvent) => void): this;
```
After the `emit(event: "result", ...)` line add:
```ts
  emit(event: "diagnostic", diag: DiagnosticEvent): boolean;
```

- [ ] **Step 6: Export `DiagnosticEvent` from the package index**

In `packages/server/src/index.ts`, replace:
```ts
export type { ClaudeProcessOptions, PermissionEvent } from "./claude-process.js";
```
with:
```ts
export type { ClaudeProcessOptions, PermissionEvent, DiagnosticEvent } from "./claude-process.js";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/claude-process.diagnostic.test.ts`
Expected: PASS (parser diagnostic on malformed line; stderr diagnostic containing `"auth expired"`). Then run `pnpm exec vitest run packages/server` to confirm no regressions.

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add packages/server/src/claude-process.ts packages/server/src/index.ts packages/server/test/helpers/mock-claude-interactive.mjs packages/server/test/claude-process.diagnostic.test.ts packages/server/test/claude-process.simple.test.ts
git commit -m "feat(server): ClaudeProcess diagnostic channel (stderr + malformed-line, no console)"
```

---

### Task 3: `ServerRuntimeConfig` + `loadServerConfig`

**Files:**
- Create: `packages/server/src/server-config.ts`
- Modify: `packages/server/src/index.ts` (export the new symbols)
- Test: `packages/server/test/server-config.test.ts` (create)

**Canonical shapes:** spec §6.1 (`config`: "Load port, bind address, access token, default model/effort … from env/flags") and §9 ("If bound to a non-loopback address with no token, the server refuses to start"). This is a NEW pure function distinct from Plan 2's `loadConfig` (which only handled `claudeBin`/`defaultModel`/`defaultEffort`). `loadServerConfig` returns the HTTP/WS runtime settings AND embeds the existing `ServerConfig` so a single object configures everything.

**Interfaces:**
- Consumes (from Plan 2): `loadConfig`, `ServerConfig` from `./config.js`.
- Produces:
  - `interface ServerRuntimeConfig { port: number; bindAddress: string; accessToken?: string; fsRoot: string; maxUploadBytes: number; trustProxy?: boolean; claude: ServerConfig }`. `trustProxy` (optional, default `false`) is passed to Fastify so `request.ip` is derived from `X-Forwarded-For` behind a reverse proxy — required for per-client lockout to mean anything behind Caddy/Cloudflare (see Task 4's proxy caveat).
  - `function loadServerConfig(env: NodeJS.ProcessEnv): ServerRuntimeConfig` — pure. Reads `PORT` (default `4280`), `BIND_ADDRESS` (default `"127.0.0.1"`), `ACCESS_TOKEN` (optional), `FS_ROOT` (default `env.HOME ?? process.cwd()`), `MAX_UPLOAD_BYTES` (default `26214400` = 25 MiB), `TRUST_PROXY` (set `trustProxy:true` when the value is `"1"` or `"true"`), and embeds `loadConfig(env)` as `claude`. Never reads `ANTHROPIC_API_KEY`.
  - `function isLoopbackAddress(address: string): boolean` — pure helper; `true` for `"127.0.0.1"`, `"::1"`, `"localhost"`, and any `127.x.x.x`.
  - `function assertConfigAllowsStart(cfg: ServerRuntimeConfig): void` — throws an `Error` whose message contains `"refusing to start"` when `bindAddress` is non-loopback and `accessToken` is missing/empty (spec §9). No-op otherwise.

- [ ] **Step 1: Write the failing test**

`packages/server/test/server-config.test.ts`:
```ts
import { expect, test } from "vitest";
import {
  loadServerConfig,
  isLoopbackAddress,
  assertConfigAllowsStart,
} from "../src/index.js";

test("loadServerConfig applies safe defaults (loopback, port 4280, no token)", () => {
  const cfg = loadServerConfig({ HOME: "/home/u" });
  expect(cfg.port).toBe(4280);
  expect(cfg.bindAddress).toBe("127.0.0.1");
  expect(cfg.accessToken).toBeUndefined();
  expect(cfg.fsRoot).toBe("/home/u");
  expect(cfg.maxUploadBytes).toBe(26214400);
  expect(cfg.claude.claudeBin).toBe("claude");
});

test("loadServerConfig reads PORT, BIND_ADDRESS, ACCESS_TOKEN, FS_ROOT, MAX_UPLOAD_BYTES", () => {
  const cfg = loadServerConfig({
    PORT: "8080",
    BIND_ADDRESS: "0.0.0.0",
    ACCESS_TOKEN: "secret-token",
    FS_ROOT: "/srv/projects",
    MAX_UPLOAD_BYTES: "1048576",
    CLAUDE_DEFAULT_MODEL: "opus",
  });
  expect(cfg.port).toBe(8080);
  expect(cfg.bindAddress).toBe("0.0.0.0");
  expect(cfg.accessToken).toBe("secret-token");
  expect(cfg.fsRoot).toBe("/srv/projects");
  expect(cfg.maxUploadBytes).toBe(1048576);
  expect(cfg.claude.defaultModel).toBe("opus");
});

test("loadServerConfig defaults trustProxy off and reads TRUST_PROXY", () => {
  expect(loadServerConfig({}).trustProxy).toBeFalsy();
  expect(loadServerConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
  expect(loadServerConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
  expect(loadServerConfig({ TRUST_PROXY: "no" }).trustProxy).toBeFalsy();
});

test("loadServerConfig never surfaces ANTHROPIC_API_KEY", () => {
  const cfg = loadServerConfig({ ANTHROPIC_API_KEY: "sk-should-be-ignored" });
  expect(JSON.stringify(cfg)).not.toContain("sk-should-be-ignored");
});

test("isLoopbackAddress recognises loopback forms", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("localhost")).toBe(true);
  expect(isLoopbackAddress("127.5.6.7")).toBe(true);
  expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  expect(isLoopbackAddress("192.168.1.10")).toBe(false);
});

test("assertConfigAllowsStart refuses a non-loopback bind without a token", () => {
  const cfg = loadServerConfig({ BIND_ADDRESS: "0.0.0.0" });
  expect(() => assertConfigAllowsStart(cfg)).toThrow(/refusing to start/);
});

test("assertConfigAllowsStart allows non-loopback WITH a token", () => {
  const cfg = loadServerConfig({ BIND_ADDRESS: "0.0.0.0", ACCESS_TOKEN: "t" });
  expect(() => assertConfigAllowsStart(cfg)).not.toThrow();
});

test("assertConfigAllowsStart allows loopback without a token", () => {
  const cfg = loadServerConfig({ BIND_ADDRESS: "127.0.0.1" });
  expect(() => assertConfigAllowsStart(cfg)).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/server-config.test.ts`
Expected: FAIL — `loadServerConfig` / `isLoopbackAddress` / `assertConfigAllowsStart` are not exported.

- [ ] **Step 3: Write `server-config.ts`**

`packages/server/src/server-config.ts`:
```ts
import { loadConfig } from "./config.js";
import type { ServerConfig } from "./config.js";

export interface ServerRuntimeConfig {
  /** TCP port to listen on. Default 4280. */
  port: number;
  /** Address to bind. Default "127.0.0.1" (loopback). */
  bindAddress: string;
  /** Mandatory access token. Optional only for loopback binds (spec §9). */
  accessToken?: string;
  /** Root directory the file picker / fs-service is confined to. Default $HOME or cwd. */
  fsRoot: string;
  /** Max bytes accepted for an upload. Default 25 MiB. */
  maxUploadBytes: number;
  /**
   * Trust X-Forwarded-* (passed to Fastify as `trustProxy`). Default false.
   * Set true when running behind a reverse proxy (Caddy/Cloudflare) so `request.ip` is the
   * real client IP — otherwise the per-client auth lockout collapses to the proxy's single IP.
   */
  trustProxy?: boolean;
  /** The claude-spawn config (claudeBin + default model/effort). */
  claude: ServerConfig;
}

export function loadServerConfig(env: NodeJS.ProcessEnv): ServerRuntimeConfig {
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 4280;
  const maxUploadBytes = env.MAX_UPLOAD_BYTES
    ? Number.parseInt(env.MAX_UPLOAD_BYTES, 10)
    : 26214400;
  const cfg: ServerRuntimeConfig = {
    port,
    bindAddress: env.BIND_ADDRESS ?? "127.0.0.1",
    fsRoot: env.FS_ROOT ?? env.HOME ?? process.cwd(),
    maxUploadBytes,
    claude: loadConfig(env),
  };
  if (env.ACCESS_TOKEN) cfg.accessToken = env.ACCESS_TOKEN;
  if (env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true") cfg.trustProxy = true;
  return cfg;
}

export function isLoopbackAddress(address: string): boolean {
  if (address === "::1" || address === "localhost") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(address);
}

/** Spec §9: refuse to serve a non-loopback bind without a token. */
export function assertConfigAllowsStart(cfg: ServerRuntimeConfig): void {
  if (!isLoopbackAddress(cfg.bindAddress) && !cfg.accessToken) {
    throw new Error(
      `refusing to start: bind address ${cfg.bindAddress} is not loopback and no ACCESS_TOKEN is set (set ACCESS_TOKEN or bind to 127.0.0.1)`,
    );
  }
}
```

- [ ] **Step 4: Export from the package index**

In `packages/server/src/index.ts`, append:
```ts
export {
  loadServerConfig,
  isLoopbackAddress,
  assertConfigAllowsStart,
} from "./server-config.js";
export type { ServerRuntimeConfig } from "./server-config.js";
```

- [ ] **Step 5: Run tests to verify they pass + typecheck**

Run: `pnpm exec vitest run packages/server/test/server-config.test.ts`
Expected: PASS (all 7 cases).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server-config.ts packages/server/src/index.ts packages/server/test/server-config.test.ts
git commit -m "feat(server): ServerRuntimeConfig (port/bind/token/fsRoot) + refuse-to-start guard"
```

---

### Task 4: `AuthGate` — constant-time token check + lockout

**Files:**
- Create: `packages/server/src/auth.ts`
- Modify: `packages/server/src/index.ts` (export the new symbols)
- Test: `packages/server/test/auth.test.ts` (create)

**Canonical shapes:** spec §9 ("constant-time token comparison, rate-limit + temporary lockout on failed auth, generic 401s"). This task is the **pure** core — no Fastify dependency. A single global Fastify `preHandler` (Task 8) is built on `AuthGate.check(...)`; because that hook runs for the WebSocket upgrade GET too (verified), it covers BOTH the REST routes and the WS handshake (the WS upgrade carries the token in the `Authorization` header or the `?token=` query param). `AuthGate` itself stays I/O-free and unit-testable here.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function extractBearerToken(authorizationHeader: string | undefined): string | undefined` — pure; returns the token from `"Bearer <token>"` (case-insensitive scheme), else `undefined`.
  - `interface AuthGateOptions { token?: string; maxFailures?: number; lockoutMs?: number; now?: () => number }` — `maxFailures` default 10, `lockoutMs` default 60000, `now` default `Date.now` (injectable for tests).
  - `class AuthGate` with:
    - `constructor(opts: AuthGateOptions)`.
    - `check(presentedToken: string | undefined, clientKey: string): { ok: true } | { ok: false; reason: "locked" | "invalid" | "missing-token-config" }` — constant-time compare; tracks failures per `clientKey` (e.g. remote IP); locks a `clientKey` out after `maxFailures` consecutive failures for `lockoutMs`; a success resets that key's failure count. If the gate was constructed with no `token`, every `check` returns `{ ok:false, reason:"missing-token-config" }` (a server bound loopback with no token still must not silently allow — but Task 8 only mounts the gate when a token is configured; see that task).

> **Proxy lockout caveat (NOT a production guarantee without config).** The lockout is keyed by `clientKey`, which Task 8 sets to `request.ip`. Behind the recommended Caddy / Cloudflare reverse proxy (spec §9), `request.ip` is the **proxy's** IP for *every* client, so the per-client lockout **collapses to one shared key → a self-DoS** (one attacker locks out all legitimate users). `AuthGate` stays IP-agnostic (it just hashes whatever `clientKey` it's given); the **deployment** must give it a real per-client key. Task 8 exposes this via Fastify's `trustProxy` option (so `request.ip` is derived from `X-Forwarded-For`) — see Task 8 Step 4. Document that per-client lockout requires `trustProxy` (or an equivalent forwarded-IP source) when running behind a proxy.

- [ ] **Step 1: Write the failing test**

`packages/server/test/auth.test.ts`:
```ts
import { expect, test } from "vitest";
import { AuthGate, extractBearerToken } from "../src/index.js";

test("extractBearerToken parses the Bearer scheme case-insensitively", () => {
  expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  expect(extractBearerToken("bearer abc123")).toBe("abc123");
  expect(extractBearerToken("Token abc123")).toBeUndefined();
  expect(extractBearerToken(undefined)).toBeUndefined();
  expect(extractBearerToken("Bearer")).toBeUndefined();
});

test("check() accepts the right token and rejects the wrong one", () => {
  const gate = new AuthGate({ token: "s3cret" });
  expect(gate.check("s3cret", "ip-a")).toEqual({ ok: true });
  expect(gate.check("nope", "ip-a")).toEqual({ ok: false, reason: "invalid" });
});

test("check() rejects a missing presented token as invalid", () => {
  const gate = new AuthGate({ token: "s3cret" });
  expect(gate.check(undefined, "ip-a")).toEqual({ ok: false, reason: "invalid" });
});

test("a gate with no configured token never accepts", () => {
  const gate = new AuthGate({});
  expect(gate.check("anything", "ip-a")).toEqual({ ok: false, reason: "missing-token-config" });
});

test("repeated failures lock the client out, and the lock expires", () => {
  let t = 1000;
  const gate = new AuthGate({ token: "s3cret", maxFailures: 3, lockoutMs: 5000, now: () => t });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" }); // 3rd failure trips the lock
  // Now locked: even the CORRECT token is refused while locked.
  expect(gate.check("s3cret", "ip-x")).toEqual({ ok: false, reason: "locked" });
  // Advance past the lockout window -> allowed again.
  t += 5001;
  expect(gate.check("s3cret", "ip-x")).toEqual({ ok: true });
});

test("lockout is per-client; a success resets the failure count", () => {
  let t = 0;
  const gate = new AuthGate({ token: "s3cret", maxFailures: 2, lockoutMs: 1000, now: () => t });
  expect(gate.check("bad", "ip-1")).toEqual({ ok: false, reason: "invalid" });
  // A different client is unaffected.
  expect(gate.check("s3cret", "ip-2")).toEqual({ ok: true });
  // A success on ip-1 before it trips clears its count.
  expect(gate.check("s3cret", "ip-1")).toEqual({ ok: true });
  expect(gate.check("bad", "ip-1")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("s3cret", "ip-1")).toEqual({ ok: true }); // still not locked (count was reset)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/auth.test.ts`
Expected: FAIL — `AuthGate` / `extractBearerToken` are not exported.

- [ ] **Step 3: Write `auth.ts`**

`packages/server/src/auth.ts`:
```ts
import { timingSafeEqual } from "node:crypto";

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : undefined;
}

/** Constant-time string compare that does not leak length via early return. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal lengths; compare against a fixed-length digest-free padding.
  if (bufA.length !== bufB.length) {
    // Still do a compare to keep timing uniform, then return false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface AuthGateOptions {
  token?: string;
  /** Consecutive failures from one client before it is locked out. Default 10. */
  maxFailures?: number;
  /** Lockout duration in ms. Default 60000. */
  lockoutMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export type AuthCheckResult =
  | { ok: true }
  | { ok: false; reason: "locked" | "invalid" | "missing-token-config" };

interface ClientState {
  failures: number;
  lockedUntil: number;
}

export class AuthGate {
  private readonly token?: string;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly clients = new Map<string, ClientState>();

  constructor(opts: AuthGateOptions) {
    this.token = opts.token;
    this.maxFailures = opts.maxFailures ?? 10;
    this.lockoutMs = opts.lockoutMs ?? 60000;
    this.now = opts.now ?? Date.now;
  }

  check(presentedToken: string | undefined, clientKey: string): AuthCheckResult {
    if (!this.token) return { ok: false, reason: "missing-token-config" };

    const state = this.clients.get(clientKey) ?? { failures: 0, lockedUntil: 0 };
    const t = this.now();
    if (state.lockedUntil > t) return { ok: false, reason: "locked" };

    const valid = presentedToken !== undefined && constantTimeEqual(presentedToken, this.token);
    if (valid) {
      this.clients.delete(clientKey); // reset on success
      return { ok: true };
    }

    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      state.lockedUntil = t + this.lockoutMs;
      state.failures = 0; // reset the counter; the lock now governs
    }
    this.clients.set(clientKey, state);
    return { ok: false, reason: "invalid" };
  }
}
```

- [ ] **Step 4: Export from the package index**

In `packages/server/src/index.ts`, append:
```ts
export { AuthGate, extractBearerToken } from "./auth.js";
export type { AuthGateOptions, AuthCheckResult } from "./auth.js";
```

- [ ] **Step 5: Run tests to verify they pass + typecheck**

Run: `pnpm exec vitest run packages/server/test/auth.test.ts`
Expected: PASS (all 6 cases). If the "lock expires" case fails, confirm `lockedUntil` is compared with `>` against `now()` and the lockout window math uses the injected clock.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth.ts packages/server/src/index.ts packages/server/test/auth.test.ts
git commit -m "feat(server): AuthGate — constant-time token check + per-client lockout"
```

---

### Task 5: `FsService` — guarded directory listing + file read/write

**Files:**
- Create: `packages/server/src/fs-service.ts`
- Modify: `packages/server/src/index.ts` (export the new symbols)
- Test: `packages/server/test/fs-service.test.ts` (create)

**Canonical shapes:** spec §6.1 (`fs-service`: "Directory listing for the picker (rooted/guarded), file read/write for uploads (into cwd or as image blocks) and downloads"), §6.3 (picker: "Git-aware: mark directories that are git repos and show the current branch"), §10 (upload limits — enforced at the transport layer in Task 10). Path traversal is guarded by resolving every path under a configured root and rejecting anything that escapes it.

**Interfaces:**
- Consumes (from Plan 0): `buildImageBlock` from `@roamcode/protocol` (re-exported helper for the image-block path); type `ImageBlock`.
- Produces:
  - `interface DirEntry { name: string; path: string; isDirectory: boolean; isGitRepo: boolean; gitBranch?: string }`.
  - `interface DirListing { path: string; parent?: string; entries: DirEntry[] }`.
  - `interface FsServiceOptions { root: string }`.
  - `class FsService` with:
    - `constructor(opts: FsServiceOptions)` — `root` is resolved to an absolute path; all operations are confined to it.
    - `resolveWithinRoot(target: string): string` — resolves `target` (absolute or relative to root) and throws an `Error` containing `"outside the allowed root"` if it escapes `root`.
    - `listDirectory(target: string): Promise<DirListing>` — lists immediate children (directories first, then files, name-sorted), marks git repos (a child dir containing a `.git` entry) and reads the branch from `.git/HEAD` (cheap, no `git` subprocess). Throws if `target` is not a directory.
    - `readFileForDownload(target: string): Promise<{ filename: string; data: Buffer }>` — reads a file under root.
    - `writeUploadedFile(targetDir: string, filename: string, data: Buffer): Promise<{ path: string }>` — writes `data` to `targetDir/filename` (both under root); rejects a `filename` containing a path separator.
    - `buildImageBlockFromUpload(mediaType: string, data: Buffer): ImageBlock` — base64-encodes `data` and returns a protocol `ImageBlock` (delegates to `buildImageBlock`).

- [ ] **Step 1: Write the failing test**

`packages/server/test/fs-service.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FsService } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-fs-"));
  // root/
  //   project-a/.git/HEAD            (a git repo on branch "main")
  //   plain-dir/
  //   notes.txt
  mkdirSync(join(root, "project-a", ".git"), { recursive: true });
  writeFileSync(join(root, "project-a", ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "plain-dir"));
  writeFileSync(join(root, "notes.txt"), "hello notes");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("listDirectory lists children, dirs first, marks git repos + branch", async () => {
  const fs = new FsService({ root });
  const listing = await fs.listDirectory(root);
  expect(listing.path).toBe(root);
  const names = listing.entries.map((e) => e.name);
  // directories first (project-a, plain-dir), then files (notes.txt)
  expect(names).toEqual(["plain-dir", "project-a", "notes.txt"]);
  const repo = listing.entries.find((e) => e.name === "project-a")!;
  expect(repo.isDirectory).toBe(true);
  expect(repo.isGitRepo).toBe(true);
  expect(repo.gitBranch).toBe("main");
  const plain = listing.entries.find((e) => e.name === "plain-dir")!;
  expect(plain.isGitRepo).toBe(false);
});

test("resolveWithinRoot rejects path traversal", () => {
  const fs = new FsService({ root });
  expect(() => fs.resolveWithinRoot("../../etc/passwd")).toThrow(/outside the allowed root/);
  expect(() => fs.resolveWithinRoot("/etc/passwd")).toThrow(/outside the allowed root/);
  // a legit child resolves fine
  expect(fs.resolveWithinRoot("plain-dir")).toBe(join(root, "plain-dir"));
});

test("readFileForDownload returns file bytes; traversal is blocked", async () => {
  const fs = new FsService({ root });
  const file = await fs.readFileForDownload(join(root, "notes.txt"));
  expect(file.filename).toBe("notes.txt");
  expect(file.data.toString("utf8")).toBe("hello notes");
  await expect(fs.readFileForDownload("../secret")).rejects.toThrow(/outside the allowed root/);
});

test("writeUploadedFile writes under root and rejects separators in the name", async () => {
  const fs = new FsService({ root });
  const out = await fs.writeUploadedFile(root, "upload.txt", Buffer.from("data"));
  expect(out.path).toBe(join(root, "upload.txt"));
  const back = await fs.readFileForDownload(out.path);
  expect(back.data.toString("utf8")).toBe("data");
  await expect(fs.writeUploadedFile(root, "../evil.txt", Buffer.from("x"))).rejects.toThrow();
  await expect(fs.writeUploadedFile(root, "sub/evil.txt", Buffer.from("x"))).rejects.toThrow();
});

test("buildImageBlockFromUpload returns a protocol image block", () => {
  const fs = new FsService({ root });
  const block = fs.buildImageBlockFromUpload("image/png", Buffer.from("PNGDATA"));
  expect(block.type).toBe("image");
  expect(block.source.media_type).toBe("image/png");
  expect(block.source.data).toBe(Buffer.from("PNGDATA").toString("base64"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/fs-service.test.ts`
Expected: FAIL — `FsService` is not exported.

- [ ] **Step 3: Write `fs-service.ts`**

`packages/server/src/fs-service.ts`:
```ts
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, sep, basename } from "node:path";
import { buildImageBlock } from "@roamcode/protocol";
import type { ImageBlock } from "@roamcode/protocol";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

export interface FsServiceOptions {
  root: string;
}

export class FsService {
  private readonly root: string;

  constructor(opts: FsServiceOptions) {
    this.root = resolve(opts.root);
  }

  /** Resolve a target (absolute or relative to root) and confine it to root. */
  resolveWithinRoot(target: string): string {
    const resolved = resolve(this.root, target);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new Error(`path is outside the allowed root: ${target}`);
    }
    return resolved;
  }

  async listDirectory(target: string): Promise<DirListing> {
    const dir = this.resolveWithinRoot(target);
    const dirStat = await stat(dir);
    if (!dirStat.isDirectory()) throw new Error(`not a directory: ${target}`);

    const dirents = await readdir(dir, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      const full = join(dir, d.name);
      const isDirectory = d.isDirectory();
      let isGitRepo = false;
      let gitBranch: string | undefined;
      if (isDirectory) {
        gitBranch = await this.readGitBranch(full);
        isGitRepo = gitBranch !== undefined;
      }
      entries.push({ name: d.name, path: full, isDirectory, isGitRepo, gitBranch });
    }

    // Directories first, then files; each group name-sorted.
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = dir === this.root ? undefined : resolve(dir, "..");
    return { path: dir, parent, entries };
  }

  /** Read .git/HEAD cheaply; return the branch name or undefined if not a repo. */
  private async readGitBranch(dirPath: string): Promise<string | undefined> {
    try {
      const head = await readFile(join(dirPath, ".git", "HEAD"), "utf8");
      const m = /^ref:\s+refs\/heads\/(.+)\s*$/.exec(head.trim());
      if (m) return m[1];
      // Detached HEAD: return the short commit.
      return head.trim().slice(0, 8);
    } catch {
      return undefined;
    }
  }

  async readFileForDownload(target: string): Promise<{ filename: string; data: Buffer }> {
    const file = this.resolveWithinRoot(target);
    const data = await readFile(file);
    return { filename: basename(file), data };
  }

  async writeUploadedFile(targetDir: string, filename: string, data: Buffer): Promise<{ path: string }> {
    if (filename.includes("/") || filename.includes("\\") || filename.includes(sep)) {
      throw new Error(`invalid upload filename (no path separators allowed): ${filename}`);
    }
    const dir = this.resolveWithinRoot(targetDir);
    const dest = this.resolveWithinRoot(join(dir, filename));
    await writeFile(dest, data);
    return { path: dest };
  }

  buildImageBlockFromUpload(mediaType: string, data: Buffer): ImageBlock {
    return buildImageBlock(mediaType, data.toString("base64"));
  }
}
```

- [ ] **Step 4: Export from the package index**

In `packages/server/src/index.ts`, append:
```ts
export { FsService } from "./fs-service.js";
export type { DirEntry, DirListing, FsServiceOptions } from "./fs-service.js";
```

- [ ] **Step 5: Run tests to verify they pass + typecheck**

Run: `pnpm exec vitest run packages/server/test/fs-service.test.ts`
Expected: PASS (all 5 cases). If the listing order assertion fails, confirm the sort puts directories first (`plain-dir`, `project-a`) before the file (`notes.txt`).
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/fs-service.ts packages/server/src/index.ts packages/server/test/fs-service.test.ts
git commit -m "feat(server): FsService — guarded listing (git-aware) + file read/write + image block"
```

---

### Task 6: `ReplayBuffer` — per-session ring that never drops permission/result

**Files:**
- Create: `packages/server/src/replay-buffer.ts`
- Modify: `packages/server/src/index.ts` (export the new symbols)
- Test: `packages/server/test/replay-buffer.test.ts` (create)

**Canonical shapes:** spec §10 ("WS reconnect: per-session ring buffer of recent events replayed on reconnect" and "Backpressure … but never drop final messages or `control_request`s — a permission prompt must never be lost"). The buffer assigns a monotonic `seq` to each pushed frame, evicts the oldest **non-critical** frame when over capacity, and NEVER evicts a `permission`/`result` frame.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ServerFrameKind = "event" | "permission" | "result" | "diagnostic" | "exit"`.
  - `interface ServerFrame { seq: number; kind: ServerFrameKind; payload: unknown }`.
  - `class ReplayBuffer` with:
    - `constructor(capacity?: number)` — capacity counts **non-critical** frames; default 200.
    - `push(kind: ServerFrameKind, payload: unknown): ServerFrame` — assigns the next `seq` (starting at 1), stores the frame, evicts oldest non-critical if over capacity, returns the stored frame.
    - `snapshot(): ServerFrame[]` — all retained frames, in original `seq` order (for replay on subscribe).
    - `since(seq: number): ServerFrame[]` — retained frames with `seq > seq` (for incremental catch-up).
  - `function isCriticalKind(kind: ServerFrameKind): boolean` — `true` for `"permission"` and `"result"`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/replay-buffer.test.ts`:
```ts
import { expect, test } from "vitest";
import { ReplayBuffer, isCriticalKind } from "../src/index.js";

test("push assigns monotonic seq starting at 1 and snapshot preserves order", () => {
  const buf = new ReplayBuffer(100);
  const a = buf.push("event", { n: 1 });
  const b = buf.push("event", { n: 2 });
  expect(a.seq).toBe(1);
  expect(b.seq).toBe(2);
  expect(buf.snapshot().map((f) => f.seq)).toEqual([1, 2]);
});

test("isCriticalKind marks permission and result critical only", () => {
  expect(isCriticalKind("permission")).toBe(true);
  expect(isCriticalKind("result")).toBe(true);
  expect(isCriticalKind("event")).toBe(false);
  expect(isCriticalKind("diagnostic")).toBe(false);
  expect(isCriticalKind("exit")).toBe(false);
});

test("over-capacity eviction drops oldest NON-critical frames only", () => {
  const buf = new ReplayBuffer(2); // capacity = 2 non-critical frames
  buf.push("event", { n: 1 }); // seq 1 (non-critical)
  buf.push("permission", { id: "p" }); // seq 2 (critical — never evicted)
  buf.push("event", { n: 2 }); // seq 3 (non-critical) -> now 2 non-critical, at capacity
  buf.push("event", { n: 3 }); // seq 4 (non-critical) -> evict oldest non-critical (seq 1)

  const seqs = buf.snapshot().map((f) => f.seq);
  expect(seqs).toContain(2); // the permission frame survives
  expect(seqs).not.toContain(1); // the oldest non-critical was evicted
  expect(seqs).toEqual([2, 3, 4]);
});

test("a permission frame is NEVER evicted even under heavy non-critical churn", () => {
  const buf = new ReplayBuffer(1);
  buf.push("permission", { id: "keep-me" }); // critical
  for (let i = 0; i < 50; i++) buf.push("event", { i });
  const perms = buf.snapshot().filter((f) => f.kind === "permission");
  expect(perms).toHaveLength(1);
  expect((perms[0].payload as { id: string }).id).toBe("keep-me");
});

test("since(seq) returns only frames after the given seq", () => {
  const buf = new ReplayBuffer(100);
  buf.push("event", { n: 1 });
  buf.push("result", { n: 2 });
  buf.push("event", { n: 3 });
  expect(buf.since(1).map((f) => f.seq)).toEqual([2, 3]);
  expect(buf.since(3)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/replay-buffer.test.ts`
Expected: FAIL — `ReplayBuffer` / `isCriticalKind` are not exported.

- [ ] **Step 3: Write `replay-buffer.ts`**

`packages/server/src/replay-buffer.ts`:
```ts
export type ServerFrameKind = "event" | "permission" | "result" | "diagnostic" | "exit";

export interface ServerFrame {
  seq: number;
  kind: ServerFrameKind;
  payload: unknown;
}

export function isCriticalKind(kind: ServerFrameKind): boolean {
  return kind === "permission" || kind === "result";
}

/**
 * Per-session ring buffer for WS reconnect replay (spec §10).
 * `capacity` bounds NON-critical frames; permission/result frames are never evicted.
 */
export class ReplayBuffer {
  private readonly capacity: number;
  private frames: ServerFrame[] = [];
  private nextSeq = 1;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  push(kind: ServerFrameKind, payload: unknown): ServerFrame {
    const frame: ServerFrame = { seq: this.nextSeq++, kind, payload };
    this.frames.push(frame);
    this.evictIfNeeded();
    return frame;
  }

  private evictIfNeeded(): void {
    let nonCritical = this.frames.reduce((n, f) => (isCriticalKind(f.kind) ? n : n + 1), 0);
    while (nonCritical > this.capacity) {
      const idx = this.frames.findIndex((f) => !isCriticalKind(f.kind));
      if (idx === -1) break; // only critical frames remain — keep them all
      this.frames.splice(idx, 1);
      nonCritical -= 1;
    }
  }

  snapshot(): ServerFrame[] {
    return [...this.frames];
  }

  since(seq: number): ServerFrame[] {
    return this.frames.filter((f) => f.seq > seq);
  }
}
```

- [ ] **Step 4: Export from the package index**

In `packages/server/src/index.ts`, append:
```ts
export { ReplayBuffer, isCriticalKind } from "./replay-buffer.js";
export type { ServerFrame, ServerFrameKind } from "./replay-buffer.js";
```

- [ ] **Step 5: Run tests to verify they pass + typecheck**

Run: `pnpm exec vitest run packages/server/test/replay-buffer.test.ts`
Expected: PASS (all 5 cases). If the eviction test fails, confirm `evictIfNeeded` only counts/removes non-critical frames.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/replay-buffer.ts packages/server/src/index.ts packages/server/test/replay-buffer.test.ts
git commit -m "feat(server): ReplayBuffer ring (never drops permission/result) for WS reconnect"
```

---

### Task 7: `SessionHub` — attach to `ClaudeProcess` events, fan out + replay

**Files:**
- Create: `packages/server/src/session-hub.ts`
- Modify: `packages/server/src/index.ts` (export the new symbols)
- Test: `packages/server/test/session-hub.test.ts` (create)

**Canonical shapes:** spec §7 step 4–6 (broadcast every parsed event over the per-session stream; mark turn complete on `result`), §10 (reconnect replay buffer). The hub is the **transport-agnostic** glue: it wraps `SessionManager`, attaches one listener set per session that turns `ClaudeProcess` events into `ServerFrame`s (pushed into that session's `ReplayBuffer` AND delivered to live subscribers), and records per-session metadata for the REST layer. Testable with no HTTP.

**Interfaces:**
- Consumes (from Plan 2): `SessionManager`, `Session`, `CreateSessionOptions`; (Task 6): `ReplayBuffer`, `ServerFrame`, `ServerFrameKind`; (Task 1/2): `ClaudeProcess` events `"event"`, `"permission"`, `"result"`, `"diagnostic"`, `"exit"`; (protocol) types `ContentBlock`, `HookPermissionDecision`.
- Produces:
  - `type SessionStatus = "running" | "errored" | "stopped"`.
  - `interface SessionMeta { id: string; cwd: string; model?: string; effort?: string; dangerouslySkip: boolean; status: SessionStatus; createdAt: number }`.
  - `type FrameListener = (frame: ServerFrame) => void`.
  - `interface Subscription { unsubscribe(): void }`.
  - `class SessionHub` with:
    - `constructor(manager: SessionManager, opts?: { replayCapacity?: number; now?: () => number })`.
    - `createSession(opts: CreateSessionOptions): Promise<SessionMeta>` — calls `manager.createSession`, attaches listeners, creates the session's `ReplayBuffer`, records meta, returns the meta.
    - `listSessions(): SessionMeta[]`.
    - `getSession(id: string): SessionMeta | undefined`.
    - `getHistory(id: string): ServerFrame[]` — the session's replay-buffer snapshot (in-memory history for this plan). Throws if unknown id.
    - `subscribe(id: string, listener: FrameListener, sinceSeq?: number): Subscription` — immediately replays the buffer (`snapshot()`, or `since(sinceSeq)` when provided) to `listener`, then registers it for live frames. Throws if unknown id.
    - `sendMessage(id: string, content: string | ContentBlock[]): void` — delegates to `manager.sendMessage`. Throws if unknown id.
    - `answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): void` — delegates to `manager.answerPermission`. Throws if unknown id.
    - `stopSession(id: string): void` — marks meta `stopped`, delegates to `manager.stopSession`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/session-hub.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SessionManager, SessionHub } from "../src/index.js";
import type { ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function hubFor(mode: string) {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: mode }, startTimeoutMs: 5000 },
  );
  return new SessionHub(manager);
}

/** Resolve once a frame matching `pred` arrives on the subscription. */
function waitForFrame(
  hub: SessionHub,
  id: string,
  pred: (f: ServerFrame) => boolean,
): Promise<ServerFrame> {
  return new Promise((resolve) => {
    const sub = hub.subscribe(id, (f) => {
      if (pred(f)) {
        sub.unsubscribe();
        resolve(f);
      }
    });
  });
}

test("createSession records meta and a live subscriber receives a result frame", async () => {
  const hub = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });
  expect(meta.id).toMatch(/[0-9a-f]{8}-/i);
  expect(meta.status).toBe("running");
  expect(hub.listSessions()).toHaveLength(1);

  const resultFramePromise = waitForFrame(hub, meta.id, (f) => f.kind === "result");
  hub.sendMessage(meta.id, "hi");
  const frame = await resultFramePromise;
  expect(frame.kind).toBe("result");
  hub.stopSession(meta.id);
});

test("permission frames are delivered and answerable through the hub", async () => {
  const hub = hubFor("permission");
  const meta = await hub.createSession({ cwd: process.cwd() });

  const permPromise = waitForFrame(hub, meta.id, (f) => f.kind === "permission");
  hub.sendMessage(meta.id, "write a file");
  const permFrame = await permPromise;
  const requestId = (permFrame.payload as { requestId: string }).requestId;
  expect(typeof requestId).toBe("string");

  const resultPromise = waitForFrame(hub, meta.id, (f) => f.kind === "result");
  hub.answerPermission(meta.id, requestId, "allow", "ok");
  const resultFrame = await resultPromise;
  expect((resultFrame.payload as { permissionDenials?: unknown[] }).permissionDenials).toEqual([]);
  hub.stopSession(meta.id);
});

test("reconnect replay: a late subscriber receives buffered frames including the result", async () => {
  const hub = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });

  // Drive a full turn with a first subscriber, wait for its result.
  await waitForFrame(hub, meta.id, (f) => f.kind === "result").then(() => undefined, () => undefined);
  const firstResult = waitForFrame(hub, meta.id, (f) => f.kind === "result");
  hub.sendMessage(meta.id, "hi");
  await firstResult;

  // A brand-new subscriber (simulating reconnect) must immediately get the buffered frames.
  const replayed: ServerFrame[] = [];
  const sub = hub.subscribe(meta.id, (f) => replayed.push(f));
  sub.unsubscribe();
  expect(replayed.some((f) => f.kind === "result")).toBe(true);
  expect(replayed.length).toBeGreaterThan(0);

  // getHistory mirrors the buffer.
  expect(hub.getHistory(meta.id).some((f) => f.kind === "result")).toBe(true);
  hub.stopSession(meta.id);
});

test("unknown ids throw on hub operations", async () => {
  const hub = hubFor("simple");
  expect(() => hub.sendMessage("nope", "x")).toThrow();
  expect(() => hub.answerPermission("nope", "r", "allow")).toThrow();
  expect(() => hub.getHistory("nope")).toThrow();
  expect(() => hub.subscribe("nope", () => {})).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/session-hub.test.ts`
Expected: FAIL — `SessionHub` is not exported.

- [ ] **Step 3: Write `session-hub.ts`**

`packages/server/src/session-hub.ts`:
```ts
import { SessionManager } from "./session-manager.js";
import { ReplayBuffer } from "./replay-buffer.js";
import type { ServerFrame, ServerFrameKind } from "./replay-buffer.js";
import type { CreateSessionOptions } from "./session-manager.js";
import type { ClaudeProcess, PermissionEvent, DiagnosticEvent } from "./claude-process.js";
import type { ContentBlock, HookPermissionDecision, InboundEvent, ResultEvent } from "@roamcode/protocol";

export type SessionStatus = "running" | "errored" | "stopped";

export interface SessionMeta {
  id: string;
  cwd: string;
  model?: string;
  effort?: string;
  dangerouslySkip: boolean;
  status: SessionStatus;
  createdAt: number;
}

export type FrameListener = (frame: ServerFrame) => void;

export interface Subscription {
  unsubscribe(): void;
}

interface SessionRecord {
  meta: SessionMeta;
  buffer: ReplayBuffer;
  listeners: Set<FrameListener>;
}

export interface SessionHubOptions {
  replayCapacity?: number;
  now?: () => number;
}

export class SessionHub {
  private readonly manager: SessionManager;
  private readonly replayCapacity: number;
  private readonly now: () => number;
  private readonly records = new Map<string, SessionRecord>();

  constructor(manager: SessionManager, opts: SessionHubOptions = {}) {
    this.manager = manager;
    this.replayCapacity = opts.replayCapacity ?? 200;
    this.now = opts.now ?? Date.now;
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionMeta> {
    const session = await this.manager.createSession(opts);
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      model: opts.model,
      effort: opts.effort,
      dangerouslySkip: opts.dangerouslySkip ?? false,
      status: "running",
      createdAt: this.now(),
    };
    const record: SessionRecord = {
      meta,
      buffer: new ReplayBuffer(this.replayCapacity),
      listeners: new Set(),
    };
    this.records.set(session.id, record);
    this.attach(session.process, record);
    return meta;
  }

  private attach(proc: ClaudeProcess, record: SessionRecord): void {
    const emit = (kind: ServerFrameKind, payload: unknown) => {
      const frame = record.buffer.push(kind, payload);
      for (const listener of record.listeners) listener(frame);
    };
    proc.on("event", (ev: InboundEvent) => emit("event", ev));
    proc.on("permission", (perm: PermissionEvent) => emit("permission", perm));
    proc.on("result", (result: ResultEvent) => emit("result", result));
    proc.on("diagnostic", (diag: DiagnosticEvent) => emit("diagnostic", diag));
    proc.on("error", (err: Error) => {
      record.meta.status = "errored";
      emit("diagnostic", { source: "parser", message: err.message } satisfies DiagnosticEvent);
    });
    proc.on("exit", (info) => {
      if (record.meta.status !== "stopped") record.meta.status = "errored";
      emit("exit", info);
    });
  }

  listSessions(): SessionMeta[] {
    return [...this.records.values()].map((r) => r.meta);
  }

  getSession(id: string): SessionMeta | undefined {
    return this.records.get(id)?.meta;
  }

  getHistory(id: string): ServerFrame[] {
    return this.require(id).buffer.snapshot();
  }

  subscribe(id: string, listener: FrameListener, sinceSeq?: number): Subscription {
    const record = this.require(id);
    // Replay first (spec §10), then go live.
    const replay = sinceSeq === undefined ? record.buffer.snapshot() : record.buffer.since(sinceSeq);
    for (const frame of replay) listener(frame);
    record.listeners.add(listener);
    return {
      unsubscribe: () => {
        record.listeners.delete(listener);
      },
    };
  }

  sendMessage(id: string, content: string | ContentBlock[]): void {
    this.require(id);
    this.manager.sendMessage(id, content);
  }

  answerPermission(id: string, requestId: string, decision: HookPermissionDecision, reason?: string): void {
    this.require(id);
    this.manager.answerPermission(id, requestId, decision, reason);
  }

  stopSession(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.meta.status = "stopped";
    this.manager.stopSession(id);
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown session: ${id}`);
    return record;
  }
}
```

- [ ] **Step 4: Export from the package index**

In `packages/server/src/index.ts`, append:
```ts
export { SessionHub } from "./session-hub.js";
export type {
  SessionHubOptions,
  SessionMeta,
  SessionStatus,
  FrameListener,
  Subscription,
} from "./session-hub.js";
```

- [ ] **Step 5: Run tests to verify they pass + typecheck**

Run: `pnpm exec vitest run packages/server/test/session-hub.test.ts`
Expected: PASS (4 cases incl. reconnect replay). If the reconnect test sees no `result` in the late subscriber, confirm `subscribe` replays `buffer.snapshot()` BEFORE adding the listener, and that the `result` listener in `attach` pushes a `"result"` frame.
Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/session-hub.ts packages/server/src/index.ts packages/server/test/session-hub.test.ts
git commit -m "feat(server): SessionHub — per-session fan-out + replay over SessionManager"
```

---

### Task 8: `createServer` (Fastify) + session REST + auth preHandler

**Files:**
- Modify: `packages/server/package.json` (add Fastify deps)
- Create: `packages/server/src/transport.ts`
- Modify: `packages/server/src/index.ts` (export `createServer` + types)
- Test: `packages/server/test/transport.rest.test.ts` (create)

**Canonical shapes:** spec §6.1 (`transport`: REST endpoints + WS hub), §5 ("WebSocket + REST (token auth)"), §9 (token on every HTTP request; refuse to start non-loopback without a token). This task installs Fastify, builds `createServer(config, sessionManager)` returning a Fastify instance, wires the `AuthGate` as a global `preHandler`, and adds the session REST endpoints. The WebSocket route (Task 9) and file endpoints (Task 10) are registered in later tasks by extending the same `createServer`.

**Deps to add (Step 1):** runtime — `fastify@^5`, `@fastify/websocket@^11`, `@fastify/multipart@^10`; dev — `ws@^8` + `@types/ws@^8` (the WS *client* for tests in Tasks 9/11, and the socket type for the route handler in Task 9 — note: `@fastify/websocket` is CommonJS and does **not** export `WebSocket` as a named ESM export, so the client/type must come from `ws`).

**Interfaces:**
- Consumes (Task 3): `ServerRuntimeConfig`, `assertConfigAllowsStart`; (Task 4): `AuthGate`, `extractBearerToken`; (Task 7): `SessionHub`; (Plan 2): `SessionManager`. From `fastify`: types `FastifyInstance`, `FastifyRequest`, `FastifyReply`.
- Produces (later tasks + the entry point rely on):
  - `interface CreateServerResult { app: FastifyInstance; hub: SessionHub; authGate: AuthGate }`.
  - `function createServer(config: ServerRuntimeConfig, sessionManager: SessionManager): CreateServerResult` — constructs a `SessionHub` over `sessionManager`, an `AuthGate` from `config.accessToken`, registers a global `preHandler` that 401s any request without a valid token (this gate covers the WebSocket upgrade GET too — accepting the token from the `Authorization` header OR the `?token=` query param), and mounts the session REST routes. Does NOT call `listen` (the entry point does). When `config.accessToken` is set, the gate enforces it; when it is absent (loopback-only dev), the preHandler allows requests (the refuse-to-start guard in `assertConfigAllowsStart` is the safety net for non-loopback binds).
  - REST routes (all JSON, all token-protected):
    - `POST /sessions` body `{ cwd: string; model?: string; effort?: string; addDirs?: string[]; dangerouslySkip?: boolean }` → `201 { session: SessionMeta }`. (NOT idempotent in this plan — spec §10's idempotency guard is deferred to Plan 4; see "Out of scope".)
    - `GET /sessions` → `200 { sessions: SessionMeta[] }`.
    - `GET /sessions/:id` → `200 { session: SessionMeta; history: ServerFrame[] }` or `404`.
    - `POST /sessions/:id/stop` → `200 { ok: true }` or `404`.

- [ ] **Step 1: Add Fastify deps and install**

Edit `packages/server/package.json` — replace the `"dependencies"` block (it is the LAST block in the file):
```json
  "dependencies": {
    "@roamcode/protocol": "workspace:*"
  }
```
with (note: a trailing `"devDependencies"` block is added after it — keep the JSON comma between them):
```json
  "dependencies": {
    "@roamcode/protocol": "workspace:*",
    "fastify": "^5.1.0",
    "@fastify/websocket": "^11.0.1",
    "@fastify/multipart": "^10.0.0"
  },
  "devDependencies": {
    "ws": "^8.18.0",
    "@types/ws": "^8.5.12"
  }
```
Then run:
```bash
pnpm install
```
Expected: pnpm resolves and links `fastify`, `@fastify/websocket`, `@fastify/multipart`, and (dev) `ws` + `@types/ws` into `packages/server/node_modules`. Success when pnpm prints `Done`.

- [ ] **Step 2: Write the failing REST test**

`packages/server/test/transport.rest.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "test-token";

function makeServer(): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: "simple" },
    startTimeoutMs: 5000,
  });
  return createServer(config, manager);
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

const auth = { authorization: `Bearer ${TOKEN}` };

test("requests without a valid token get 401", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/sessions" });
  expect(res.statusCode).toBe(401);
});

test("POST /sessions creates a session and GET lists it", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd(), model: "opus" },
  });
  expect(created.statusCode).toBe(201);
  const session = created.json().session;
  expect(session.id).toMatch(/[0-9a-f]{8}-/i);
  expect(session.cwd).toBe(process.cwd());
  expect(session.model).toBe("opus");
  expect(session.status).toBe("running");

  const listed = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().sessions.map((s: { id: string }) => s.id)).toContain(session.id);
});

test("GET /sessions/:id returns the session + (empty) history; unknown -> 404", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;

  const got = await current.app.inject({ method: "GET", url: `/sessions/${id}`, headers: auth });
  expect(got.statusCode).toBe(200);
  expect(got.json().session.id).toBe(id);
  expect(Array.isArray(got.json().history)).toBe(true);

  const missing = await current.app.inject({ method: "GET", url: "/sessions/does-not-exist", headers: auth });
  expect(missing.statusCode).toBe(404);
});

test("POST /sessions/:id/stop stops a session", async () => {
  current = makeServer();
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: auth,
    payload: { cwd: process.cwd() },
  });
  const id = created.json().session.id;
  const stopped = await current.app.inject({ method: "POST", url: `/sessions/${id}/stop`, headers: auth });
  expect(stopped.statusCode).toBe(200);
  expect(stopped.json().ok).toBe(true);

  const after = await current.app.inject({ method: "GET", url: `/sessions/${id}`, headers: auth });
  expect(after.json().session.status).toBe("stopped");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/transport.rest.test.ts`
Expected: FAIL — `createServer` is not exported.

- [ ] **Step 4: Write `transport.ts` (createServer + session REST)**

`packages/server/src/transport.ts`:
```ts
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SessionHub } from "./session-hub.js";
import { AuthGate, extractBearerToken } from "./auth.js";
import type { SessionManager } from "./session-manager.js";
import type { ServerRuntimeConfig } from "./server-config.js";

export interface CreateServerResult {
  app: FastifyInstance;
  hub: SessionHub;
  authGate: AuthGate;
}

interface CreateSessionBody {
  cwd: string;
  model?: string;
  effort?: string;
  addDirs?: string[];
  dangerouslySkip?: boolean;
}

export function createServer(
  config: ServerRuntimeConfig,
  sessionManager: SessionManager,
): CreateServerResult {
  const hub = new SessionHub(sessionManager);
  const authGate = new AuthGate({ token: config.accessToken });
  // trustProxy makes request.ip honour X-Forwarded-For behind a reverse proxy, so the
  // per-client auth lockout keys on the real client IP (see Task 4's proxy caveat).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false });

  // Global token gate — applies to BOTH REST routes AND the WebSocket upgrade request
  // (a Fastify global preHandler runs for the WS route's GET upgrade and a 401 there
  // aborts the upgrade — verified). The token for a WS upgrade may arrive in the
  // Authorization header or the `?token=` query param, so accept either here.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // No token configured (loopback dev): allow. Non-loopback w/o token is blocked at startup.
    if (!config.accessToken) return;
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    const token = extractBearerToken(request.headers.authorization) ?? queryToken;
    const result = authGate.check(token, request.ip);
    if (!result.ok) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.post<{ Body: CreateSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.cwd !== "string") {
      reply.code(400).send({ error: "cwd is required" });
      return;
    }
    const session = await hub.createSession({
      cwd: body.cwd,
      model: body.model,
      effort: body.effort,
      addDirs: body.addDirs,
      dangerouslySkip: body.dangerouslySkip,
    });
    reply.code(201).send({ session });
  });

  app.get("/sessions", async () => {
    return { sessions: hub.listSessions() };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const meta = hub.getSession(request.params.id);
    if (!meta) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    return { session: meta, history: hub.getHistory(request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const meta = hub.getSession(request.params.id);
    if (!meta) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    hub.stopSession(request.params.id);
    return { ok: true };
  });

  return { app, hub, authGate };
}
```

- [ ] **Step 5: Export from the package index**

In `packages/server/src/index.ts`, append:
```ts
export { createServer } from "./transport.js";
export type { CreateServerResult } from "./transport.js";
```

- [ ] **Step 6: Run tests to verify they pass + typecheck**

Run: `pnpm exec vitest run packages/server/test/transport.rest.test.ts`
Expected: PASS (401 without token; create/list/get/stop). If `app.inject` 401s a request that has the `Bearer` header, confirm `extractBearerToken` is applied to `request.headers.authorization` and the gate token equals `TOKEN`.
Run: `pnpm typecheck`
Expected: PASS. (If `tsc` complains about Fastify generic route types, confirm the `app.get<{ Params: ... }>` / `app.post<{ Body: ... }>` generics match the handler usage shown.)

- [ ] **Step 7: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/transport.ts packages/server/src/index.ts packages/server/test/transport.rest.test.ts
git commit -m "feat(server): createServer (Fastify) + session REST + global auth preHandler"
```

---

### Task 9: WebSocket route — per-session subscribe + inbound frames

**Files:**
- Modify: `packages/server/src/transport.ts` (register `@fastify/websocket` + the WS route)
- Test: `packages/server/test/transport.ws.test.ts` (create)

**Canonical shapes:** spec §6.1/§5/§7 (per-session WS: on connect subscribe to that session's stream; broadcast every `event`/`permission`/`result`/`diagnostic`/`exit`; accept inbound frames to send a user message — text + base64 image content blocks — and to answer a permission), §9 (token-authed handshake), §10 (replay on (re)subscribe; never drop permission/result). The WS server→client frame is the `ServerFrame` shape from Task 6 (`{ seq, kind, payload }`); client→server frames are JSON objects discriminated by `type`.

**Interfaces:**
- Consumes (Task 6): `ServerFrame`; (Task 7): `SessionHub.subscribe/sendMessage/answerPermission`; (Task 8): the `createServer` body (auth is already enforced by the global preHandler — the WS handler does NOT re-check the token); (protocol): `buildImageBlock`, types `ContentBlock`, `HookPermissionDecision`. The plugin (`websocket`) is the default import from `@fastify/websocket`; the `WebSocket` socket type comes from `ws`.
- Produces (the client contract — Task 11's integration test + Plan 5 rely on):
  - **Server → client** WS messages: JSON-stringified `ServerFrame` = `{ seq: number; kind: "event"|"permission"|"result"|"diagnostic"|"exit"; payload: unknown }`. On connect, the buffered frames are sent first (replay), then live frames.
  - **Client → server** WS messages (JSON):
    - `{ type: "user"; content: string }` OR `{ type: "user"; blocks: ContentBlock[] }` OR `{ type: "user"; text?: string; images?: { mediaType: string; dataBase64: string }[] }` → builds a content-block array (text block from `text`/`content`, image blocks via `buildImageBlock`) and calls `hub.sendMessage`.
    - `{ type: "permission"; requestId: string; decision: "allow"|"deny"; reason?: string }` → `hub.answerPermission`.
  - WS handshake auth: enforced by the SAME global `preHandler` as REST (Task 8), which now also reads the `?token=` query param. An invalid token therefore makes the **upgrade fail** (HTTP 401 during the handshake → the client `ws` errors / closes with code `1006`), *before* the WS handler runs. The handler does NOT repeat the token check; it only rejects an unknown session (post-upgrade `socket.close(4404, …)`).
  - The WS route path is `GET /sessions/:id/ws`.

- [ ] **Step 1: Write the failing WS test**

`packages/server/test/transport.ws.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "test-token";

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
}

function managerFor(mode: string, config: ServerRuntimeConfig) {
  return new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: mode },
    startTimeoutMs: 5000,
  });
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

/** Start listening on an ephemeral port; return the base ws:// URL. */
async function listen(result: CreateServerResult): Promise<string> {
  const address = await result.app.listen({ port: 0, host: "127.0.0.1" });
  // address is like "http://127.0.0.1:54321"
  return address.replace(/^http/, "ws");
}

/** Open a ws to a session, collecting frames; drive + finish callbacks like the mock test. */
function openWs(
  base: string,
  id: string,
  token: string | undefined,
  onFrame: (frame: ServerFrame, ws: WebSocket) => void,
): WebSocket {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const ws = new WebSocket(`${base}/sessions/${id}/ws${q}`);
  ws.on("message", (data: Buffer) => onFrame(JSON.parse(data.toString()), ws));
  return ws;
}

async function createSession(result: CreateServerResult): Promise<string> {
  const created = await result.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { cwd: process.cwd() },
  });
  return created.json().session.id;
}

test("WS handshake without a valid token fails the upgrade (never opens / receives a frame)", async () => {
  const config = configFor();
  current = createServer(config, managerFor("simple", config));
  const base = await listen(current);
  const id = await createSession(current);

  // A wrong token is rejected by the global preHandler during the HTTP upgrade (401),
  // so the `ws` client either errors or closes WITHOUT ever opening or receiving a frame.
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base}/sessions/${id}/ws?token=wrong`);
    let gotFrame = false;
    ws.on("message", () => (gotFrame = true));
    ws.on("open", () => {
      // An open without auth would be a security bug. Fail fast.
      ws.close();
      reject(new Error("ws upgrade unexpectedly succeeded without a valid token"));
    });
    const settle = () => {
      expect(gotFrame).toBe(false);
      resolve();
    };
    ws.on("error", settle); // a 401 upgrade surfaces here as "Unexpected server response: 401"
    ws.on("close", settle); // some platforms emit close (code 1006) instead/also
    setTimeout(() => reject(new Error("ws neither errored nor closed after a rejected upgrade")), 4000);
  });
});

test("WS: send a user message, receive streamed frames + a result", async () => {
  const config = configFor();
  current = createServer(config, managerFor("simple", config));
  const base = await listen(current);
  const id = await createSession(current);

  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const kinds: string[] = [];
    const ws = openWs(base, id, TOKEN, (frame, sock) => {
      kinds.push(frame.kind);
      if (!sent) {
        sent = true;
        sock.send(JSON.stringify({ type: "user", content: "hi" }));
      }
      if (frame.kind === "result") {
        expect(kinds).toContain("event");
        sock.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("no result over ws")), 6000);
  });
});

test("WS: permission round-trip and reconnect replay", async () => {
  const config = configFor();
  current = createServer(config, managerFor("permission", config));
  const base = await listen(current);
  const id = await createSession(current);

  // First connection: drive to a permission, answer allow, get the result.
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    let answered = false;
    const ws = openWs(base, id, TOKEN, (frame, sock) => {
      if (!sent) {
        sent = true;
        sock.send(JSON.stringify({ type: "user", content: "write a file" }));
      }
      if (frame.kind === "permission" && !answered) {
        answered = true;
        const requestId = (frame.payload as { requestId: string }).requestId;
        sock.send(JSON.stringify({ type: "permission", requestId, decision: "allow", reason: "ok" }));
      }
      if (frame.kind === "result") {
        sock.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("no result over ws (permission)")), 8000);
  });

  // Reconnect: a fresh socket must immediately replay the buffered frames incl. the result.
  await new Promise<void>((resolve, reject) => {
    const replayed: string[] = [];
    const ws = openWs(base, id, TOKEN, (frame, sock) => {
      replayed.push(frame.kind);
      if (frame.kind === "result") {
        expect(replayed).toContain("permission");
        sock.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("reconnect did not replay the result")), 4000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/transport.ws.test.ts`
Expected: FAIL — `@fastify/websocket` is not registered and there is no `/sessions/:id/ws` route (connection refused / 404 upgrade).

- [ ] **Step 3: Register the WS plugin and the route in `transport.ts`**

In `packages/server/src/transport.ts`, update the imports at the top — replace:
```ts
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SessionHub } from "./session-hub.js";
import { AuthGate, extractBearerToken } from "./auth.js";
import type { SessionManager } from "./session-manager.js";
import type { ServerRuntimeConfig } from "./server-config.js";
```
with:
```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { SessionHub } from "./session-hub.js";
import { AuthGate, extractBearerToken } from "./auth.js";
import { buildImageBlock } from "@roamcode/protocol";
import type { ContentBlock, HookPermissionDecision } from "@roamcode/protocol";
import type { SessionManager } from "./session-manager.js";
import type { ServerRuntimeConfig } from "./server-config.js";
```
(`WebSocket` is imported from `ws` for the handler's `socket` parameter type — `@fastify/websocket` does not export it as a named ESM export. `ws` is a transitive dependency of `@fastify/websocket` and was added explicitly as a devDependency in Task 8.)

Then, inside `createServer`, register the plugin and the route. Place this block immediately after the `app.addHook("preHandler", ...)` registration and BEFORE the `app.post("/sessions", ...)` route:
```ts
  // WebSocket support. Registered synchronously; routes are added below.
  app.register(websocket);

  // Handshake auth is handled by the GLOBAL preHandler (it runs for the upgrade GET and
  // reads ?token= too). By the time this handler runs, the token is already validated;
  // we only reject an unknown session here.
  app.register(async (wsScope) => {
    wsScope.get<{ Params: { id: string } }>(
      "/sessions/:id/ws",
      { websocket: true },
      (socket: WebSocket, request: FastifyRequest<{ Params: { id: string } }>) => {
        const id = request.params.id;

        if (!hub.getSession(id)) {
          socket.close(4404, "session not found");
          return;
        }

        const subscription = hub.subscribe(id, (frame) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
        });

        socket.on("message", (raw: Buffer) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return; // ignore malformed client frames
          }
          handleClientFrame(hub, id, msg);
        });

        socket.on("close", () => subscription.unsubscribe());
        socket.on("error", () => subscription.unsubscribe());
      },
    );
  });
```

Finally, add the `handleClientFrame` helper at the end of the file (module scope, after `createServer`):
```ts
function handleClientFrame(hub: SessionHub, id: string, msg: Record<string, unknown>): void {
  if (msg.type === "user") {
    const blocks = toContentBlocks(msg);
    if (blocks.length > 0) hub.sendMessage(id, blocks);
    return;
  }
  if (msg.type === "permission") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
    const decision = msg.decision === "allow" || msg.decision === "deny" ? (msg.decision as HookPermissionDecision) : undefined;
    if (requestId && decision) {
      const reason = typeof msg.reason === "string" ? msg.reason : undefined;
      hub.answerPermission(id, requestId, decision, reason);
    }
    return;
  }
  // unknown frame types are ignored
}

/** A content block is only forwarded if it is a well-formed text or image block. */
function isValidContentBlock(b: unknown): b is ContentBlock {
  if (typeof b !== "object" || b === null) return false;
  const block = b as Record<string, unknown>;
  if (block.type === "text") return typeof block.text === "string";
  if (block.type === "image") {
    const src = block.source as Record<string, unknown> | undefined;
    return (
      typeof src === "object" && src !== null &&
      src.type === "base64" && typeof src.media_type === "string" && typeof src.data === "string"
    );
  }
  return false;
}

/** Build a content-block array from a flexible inbound `user` frame. Never forwards arbitrary JSON. */
function toContentBlocks(msg: Record<string, unknown>): ContentBlock[] {
  // Explicit `blocks` array: keep only well-formed text/image blocks (don't cast raw client JSON
  // straight into serializeUserMessage -> claude stdin).
  if (Array.isArray(msg.blocks)) return msg.blocks.filter(isValidContentBlock);
  const blocks: ContentBlock[] = [];
  const text = typeof msg.content === "string" ? msg.content : typeof msg.text === "string" ? msg.text : undefined;
  if (text) blocks.push({ type: "text", text });
  if (Array.isArray(msg.images)) {
    for (const img of msg.images as { mediaType?: string; dataBase64?: string }[]) {
      if (img && typeof img.mediaType === "string" && typeof img.dataBase64 === "string") {
        blocks.push(buildImageBlock(img.mediaType, img.dataBase64));
      }
    }
  }
  return blocks;
}
```

- [ ] **Step 4: Run the WS tests**

Run: `pnpm exec vitest run packages/server/test/transport.ws.test.ts`
Expected: PASS (handshake rejection fails the upgrade without opening/receiving a frame; user message streams `event` + `result`; permission round-trip; reconnect replays the buffered `permission` + `result`). Common fixes if RED:
  - If the handler signature errors under `tsc`, confirm `@fastify/websocket` is v11 (the handler is `(socket, request)`, NOT the older `(connection, request)`), and that `WebSocket` is imported from `ws` (NOT from `@fastify/websocket`, which is CommonJS and has no such named export).
  - If the reconnect replay test never sees `result`, confirm `hub.subscribe` replays the snapshot before adding the live listener (Task 7) and that frames are JSON-stringified on send.
  - If the handshake-rejection test sees the socket OPEN, the global preHandler is not gating the upgrade — confirm Task 8's preHandler reads `?token=` (via `request.query`) AND that this WS route is registered on the same `app` so the global hook applies to it. The rejected upgrade surfaces on the `ws` client as an `error` ("Unexpected server response: 401") and/or a `close` with code `1006` — the test accepts either.

- [ ] **Step 5: Run the whole server suite + typecheck**

Run:
```bash
pnpm exec vitest run packages/server
pnpm typecheck
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/transport.ts packages/server/test/transport.ws.test.ts
git commit -m "feat(server): per-session WebSocket route (subscribe + replay + inbound user/permission)"
```

---

### Task 10: File endpoints — browse, upload, download

**Files:**
- Modify: `packages/server/src/transport.ts` (construct `FsService`, register `@fastify/multipart`, add routes)
- Test: `packages/server/test/transport.files.test.ts` (create)

**Canonical shapes:** spec §6.1/§6.3 (directory browse for the picker; upload a file into the session cwd or as an image block; download a file/artifact), §10 (upload size cap → reject oversized with a clear error). The browse route returns the `DirListing` from `FsService`; uploads go through `@fastify/multipart` with `limits.fileSize = config.maxUploadBytes`; downloads stream the file bytes. All paths are confined to `config.fsRoot`.

**Interfaces:**
- Consumes (Task 5): `FsService`, `DirListing`; (Task 8): the `createServer` body (extends it). From `@fastify/multipart`: the plugin + `request.file()`.
- Produces (the client contract):
  - `GET /fs/list?path=<dir>` → `200 DirListing` (path defaults to `config.fsRoot` when omitted); `400` on a path outside the root.
  - `GET /fs/download?path=<file>` → `200` with the file bytes (`Content-Disposition: attachment; filename="…"`); `400` on traversal; `404` if missing.
  - `POST /fs/upload?dir=<targetDir>` multipart with one `file` field → `201 { path: string }`; `400` on traversal or a bad filename; `413` when the file exceeds `config.maxUploadBytes`.

- [ ] **Step 1: Write the failing files test**

`packages/server/test/transport.files.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let root: string;
let current: CreateServerResult | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-files-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "readme.md"), "# hi");
});

afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  rmSync(root, { recursive: true, force: true });
});

function makeServer(maxUploadBytes = 26214400): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: root,
    maxUploadBytes,
    claude: { claudeBin: process.execPath },
  };
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: "simple" },
    startTimeoutMs: 5000,
  });
  return createServer(config, manager);
}

test("GET /fs/list returns the listing rooted at fsRoot", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/fs/list", headers: auth });
  expect(res.statusCode).toBe(200);
  const names = res.json().entries.map((e: { name: string }) => e.name);
  expect(names).toEqual(["sub", "readme.md"]); // dir first, then file
});

test("GET /fs/list rejects path traversal with 400", async () => {
  current = makeServer();
  const res = await current.app.inject({ method: "GET", url: "/fs/list?path=../..", headers: auth });
  expect(res.statusCode).toBe(400);
});

test("GET /fs/download streams a file with an attachment header", async () => {
  current = makeServer();
  const res = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(join(root, "readme.md"))}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-disposition"]).toContain('filename="readme.md"');
  expect(res.body).toBe("# hi");
});

test("POST /fs/upload writes a file under the target dir", async () => {
  current = makeServer();
  const boundary = "----rcboundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `uploaded-content\r\n` +
    `--${boundary}--\r\n`;
  const res = await current.app.inject({
    method: "POST",
    url: `/fs/upload?dir=${encodeURIComponent(join(root, "sub"))}`,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().path).toBe(join(root, "sub", "note.txt"));

  // confirm it is downloadable
  const back = await current.app.inject({
    method: "GET",
    url: `/fs/download?path=${encodeURIComponent(join(root, "sub", "note.txt"))}`,
    headers: auth,
  });
  expect(back.body).toBe("uploaded-content");
});

test("POST /fs/upload rejects a file over the size cap with 413", async () => {
  current = makeServer(8); // 8-byte cap
  const boundary = "----rcboundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="big.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `this content is definitely longer than eight bytes\r\n` +
    `--${boundary}--\r\n`;
  const res = await current.app.inject({
    method: "POST",
    url: `/fs/upload?dir=${encodeURIComponent(root)}`,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(res.statusCode).toBe(413);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/transport.files.test.ts`
Expected: FAIL — no `/fs/*` routes; `@fastify/multipart` not registered.

- [ ] **Step 3: Construct `FsService`, register multipart, add the routes in `transport.ts`**

In `packages/server/src/transport.ts`, extend the imports — replace:
```ts
import websocket from "@fastify/websocket";
```
with:
```ts
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { FsService } from "./fs-service.js";
```

Inside `createServer`, construct the `FsService` and register multipart. Find the line that constructs the Fastify instance (from Task 8 it reads `const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false });`) and add a `fsService` line right before it and a multipart registration right after it, so the top of `createServer` becomes:
```ts
  const hub = new SessionHub(sessionManager);
  const authGate = new AuthGate({ token: config.accessToken });
  const fsService = new FsService({ root: config.fsRoot });
  // trustProxy makes request.ip honour X-Forwarded-For behind a reverse proxy, so the
  // per-client auth lockout keys on the real client IP (see Task 4's proxy caveat).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false });

  // Multipart uploads, capped at the configured size.
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });
```

Add the `/fs/*` routes — place them after the `app.post("/sessions/:id/stop", ...)` route and BEFORE `return { app, hub, authGate };`:
```ts
  app.get<{ Querystring: { path?: string } }>("/fs/list", async (request, reply) => {
    try {
      const target = request.query.path ?? config.fsRoot;
      return await fsService.listDirectory(target);
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { path?: string } }>("/fs/download", async (request, reply) => {
    if (!request.query.path) {
      reply.code(400).send({ error: "path is required" });
      return;
    }
    try {
      const file = await fsService.readFileForDownload(request.query.path);
      reply
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("content-type", "application/octet-stream")
        .send(file.data);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("outside the allowed root")) {
        reply.code(400).send({ error: message });
      } else {
        reply.code(404).send({ error: message });
      }
    }
  });

  app.post<{ Querystring: { dir?: string } }>("/fs/upload", async (request, reply) => {
    const targetDir = request.query.dir ?? config.fsRoot;
    let data;
    try {
      data = await request.file();
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
    if (!data) {
      reply.code(400).send({ error: "no file field in the upload" });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err) {
      // @fastify/multipart throws when the per-file limit is exceeded.
      reply.code(413).send({ error: (err as Error).message });
      return;
    }
    if (data.file.truncated) {
      reply.code(413).send({ error: "file exceeds the upload size limit" });
      return;
    }
    try {
      const written = await fsService.writeUploadedFile(targetDir, data.filename, buffer);
      reply.code(201).send({ path: written.path });
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/transport.files.test.ts`
Expected: PASS (list rooted at fsRoot, traversal 400, download with attachment header, upload + round-trip download, oversized → 413). Common fixes if RED:
  - If the oversized test returns 201 instead of 413, confirm BOTH guards are present: the `try/catch` around `data.toBuffer()` AND the `data.file.truncated` check (`@fastify/multipart` may surface the limit either way depending on version).
  - If `/fs/list` 400s a valid request, confirm `resolveWithinRoot` treats `config.fsRoot` itself as allowed (the `resolved === this.root` branch in Task 5).

- [ ] **Step 5: Run the whole server suite + typecheck**

Run:
```bash
pnpm exec vitest run packages/server
pnpm typecheck
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/transport.ts packages/server/test/transport.files.test.ts
git commit -m "feat(server): file endpoints — browse (rooted) + upload (capped) + download"
```

---

### Task 11: Entry point (`startServer`) + full end-to-end integration test

**Files:**
- Create: `packages/server/src/start.ts`
- Create: `packages/server/tsup.config.ts` (two-entry build; shebangs the bin)
- Modify: `packages/server/package.json` (add a `bin` + `start` script; `build` → `tsup`)
- Modify: `packages/server/src/index.ts` (export `startServer`)
- Test: `packages/server/test/integration.e2e.test.ts` (create)

**Canonical shapes:** spec §5 (always-on daemon, single port), §7 (the full data-flow: create → subscribe → message → streamed events + result → permission round-trip → resilience/replay), §9 (refuse to start non-loopback without a token). The entry point builds the runtime config from `process.env`, asserts it allows starting, constructs the production `SessionManager` (no test deps → real `claude`) and the server, and listens. The integration test exercises the whole path against the mock over real localhost sockets.

**Interfaces:**
- Consumes (Task 3): `loadServerConfig`, `assertConfigAllowsStart`; (Plan 2): `SessionManager`; (Task 8): `createServer`, `CreateServerResult`.
- Produces:
  - `function startServer(env?: NodeJS.ProcessEnv): Promise<CreateServerResult & { url: string }>` — loads config (default `process.env`), calls `assertConfigAllowsStart`, builds a production `SessionManager(config.claude)` (no mock deps), `createServer`, `await app.listen({ port, host })`, returns the result plus the listening `url`. Re-throws the refuse-to-start error so the process exits non-zero.
  - A `bin` entry `roamcode-server` → `./dist/start.js` (built output); `start.ts` runs `startServer()` when executed as the entry module.

- [ ] **Step 1: Write the failing end-to-end test**

`packages/server/test/integration.e2e.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ServerFrame } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "e2e-token";

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

test("full flow: create -> WS subscribe -> message -> events+result -> permission -> reconnect replay", async () => {
  const config = configFor();
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    baseEnv: { ...process.env, MOCK_MODE: "permission" },
    startTimeoutMs: 5000,
  });
  current = createServer(config, manager);
  const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase = httpUrl.replace(/^http/, "ws");

  // 1) Create a session over REST.
  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { cwd: process.cwd(), dangerouslySkip: false },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().session.id;

  // 2) Subscribe over WS, send a message, answer the permission, await the result.
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    let answered = false;
    const kinds: string[] = [];
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      kinds.push(frame.kind);
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "user", content: "write a file" }));
      }
      if (frame.kind === "permission" && !answered) {
        answered = true;
        const requestId = (frame.payload as { requestId: string }).requestId;
        ws.send(JSON.stringify({ type: "permission", requestId, decision: "allow", reason: "e2e" }));
      }
      if (frame.kind === "result") {
        expect(kinds).toContain("permission");
        expect((frame.payload as { permissionDenials?: unknown[] }).permissionDenials).toEqual([]);
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("e2e: no result over ws")), 10000);
  });

  // 3) Reconnect: a fresh socket replays the buffered frames (resilience — spec §7/§10).
  await new Promise<void>((resolve, reject) => {
    const replayed: string[] = [];
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      const frame: ServerFrame = JSON.parse(raw.toString());
      replayed.push(frame.kind);
      if (frame.kind === "result") {
        expect(replayed).toContain("permission");
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("e2e: reconnect did not replay")), 5000);
  });

  // 4) REST history reflects the turn.
  const history = await current.app.inject({
    method: "GET",
    url: `/sessions/${id}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(history.json().history.some((f: ServerFrame) => f.kind === "result")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/server/test/integration.e2e.test.ts`
Expected: This test uses only already-built pieces (`createServer`, the WS route, the hub). It may already PASS. If it does, that is acceptable for this step — proceed to add `startServer` (the entry point), which the test does not exercise but the package must ship. If it FAILS, fix the transport per the error before adding `startServer`. (We still author `start.ts` next so the package has a runnable entry.)

- [ ] **Step 3: Write `start.ts`**

`packages/server/src/start.ts`:
```ts
import { pathToFileURL } from "node:url";
import { SessionManager } from "./session-manager.js";
import { createServer } from "./transport.js";
import { loadServerConfig, assertConfigAllowsStart } from "./server-config.js";
import type { CreateServerResult } from "./transport.js";

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreateServerResult & { url: string }> {
  const config = loadServerConfig(env);
  assertConfigAllowsStart(config); // spec §9: refuse non-loopback bind without a token

  const manager = new SessionManager(config.claude);
  const result = createServer(config, manager);
  const url = await result.app.listen({ port: config.port, host: config.bindAddress });
  return { ...result, url };
}

// Run when executed directly (node dist/start.js), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer()
    .then(({ url }) => {
      // eslint-disable-next-line no-console
      console.log(`roamcode server listening on ${url}`);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`roamcode server failed to start: ${(err as Error).message}`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Add a `tsup.config.ts` that builds both entries and shebangs the `bin`**

The `bin` target (`dist/start.js`) must be directly executable, so it needs a `#!/usr/bin/env node` shebang. A tsup `banner` applies per-build, so use a two-entry config array — the library entry (`index.ts`) gets NO banner, the bin entry (`start.ts`) gets the shebang. The CLI `--banner` flag does not reliably parse the object form, so a config file is the correct mechanism. Create `packages/server/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Library entry — imported by other packages; no shebang.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    tsconfig: "tsconfig.build.json",
  },
  {
    // Executable entry for the `roamcode-server` bin.
    entry: ["src/start.ts"],
    format: ["esm"],
    dts: true,
    clean: false, // don't wipe the index.* output from the first config
    tsconfig: "tsconfig.build.json",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
```

- [ ] **Step 4a: Point the manifest at the config, add the `bin` + `start` script, export `startServer`**

In `packages/server/package.json`, add a `bin` field and a `start` script and switch `build` to the config file. Replace:
```json
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean --tsconfig tsconfig.build.json"
  },
```
with:
```json
  "files": ["dist"],
  "bin": { "roamcode-server": "./dist/start.js" },
  "scripts": {
    "build": "tsup",
    "start": "node dist/start.js"
  },
```

In `packages/server/src/index.ts`, append:
```ts
export { startServer } from "./start.js";
```

- [ ] **Step 5: Add a startup-guard test for the refuse-to-start path**

Append to `packages/server/test/integration.e2e.test.ts`:
```ts
test("startServer refuses a non-loopback bind without a token", async () => {
  const { startServer } = await import("../src/index.js");
  await expect(
    startServer({ BIND_ADDRESS: "0.0.0.0", CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv),
  ).rejects.toThrow(/refusing to start/);
});
```

- [ ] **Step 6: Run the integration tests to verify they pass**

Run: `pnpm exec vitest run packages/server/test/integration.e2e.test.ts`
Expected: PASS (full create→WS→message→permission→result→reconnect-replay flow; history reflects the result; `startServer` refuses a non-loopback bind without a token). If the full-flow test times out, increase nothing — instead confirm `MOCK_MODE=permission` and that the WS handler answers the permission frame (the mock blocks until the `control_response` arrives).

- [ ] **Step 7: Run the entire repo suite + typecheck + build**

Run:
```bash
pnpm test
pnpm typecheck
pnpm -C packages/server build
head -1 packages/server/dist/start.js
```
Expected: all PASS. `pnpm test` runs the `protocol` and `server` suites. The build emits `packages/server/dist/index.js`, `dist/index.d.ts`, `dist/start.js`, and `dist/start.d.ts`. The `head -1` prints `#!/usr/bin/env node` (the bin shebang from `tsup.config.ts`); `dist/index.js` must NOT have a shebang (it is the importable library entry). (Final packaging — `npx`/Docker — is completed in Plan 6; this just makes the bin directly executable.)

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/start.ts packages/server/tsup.config.ts packages/server/src/index.ts packages/server/package.json packages/server/test/integration.e2e.test.ts
git commit -m "feat(server): startServer entry point + full REST/WS integration test (mock)"
```

---

## Self-Review

**1. Spec coverage** (vs the prompt's Plan 3 scope, spec §6/§7/§9/§10, and `docs/protocol-notes.md`):

- **Multi-turn keep-alive** (drop `stdin.end()` on `result`; close stdin only in `stop()`; write-after-teardown guard surfacing a clear error; keep emitting `"result"` per turn; re-emitted `system/init` is just `"event"`-broadcast — the hub forwards every `InboundEvent` as an `"event"` frame and treats only `result` as turn-complete) → **Task 1** (+ hub fan-out in Task 7). Test drives TWO turns on one process and asserts write-after-`stop()` doesn't crash. ✓
- **Diagnostics channel** (`"diagnostic"` event carrying stderr lines; malformed-line notice routed through it instead of `console.warn`; spec §10 "auth expired") → **Task 2**. ✓
- **Server runtime config** (`ServerRuntimeConfig` + `loadServerConfig` for port/bindAddress/accessToken/fsRoot/maxUpload + default model/effort via embedded `loadConfig`; refuse-to-start when non-loopback w/o token; pure + tested) → **Task 3** (`assertConfigAllowsStart`) and enforced at boot in **Task 11**. ✓
- **auth** (constant-time bearer check via `timingSafeEqual`; one global Fastify preHandler — Task 8 — that gates BOTH REST and the WS upgrade handshake, reading the token from the `Authorization` header or `?token=`; refuse-to-start when non-loopback w/o token — Task 3/11; rate-limit/lockout on repeated failures, per-client) → **Task 4** (`AuthGate`) + the preHandler adapter in Task 8. ✓
- **transport (HTTP + WS)** with Fastify + `@fastify/websocket` + `@fastify/multipart` (not the Agent SDK): REST create/list/get+history/stop (Task 8), browse/upload/download (Task 10); per-session WS subscribe broadcasting `event`/`permission`/`result`/`diagnostic`/`exit`, inbound user (text + base64 image blocks) + permission answer (Task 9); per-session reconnect replay buffer that NEVER drops `permission`/`result` (Task 6 buffer + Task 7 hub + Task 9 replay-on-subscribe) → **Tasks 6–10**. ✓
- **fs-service** (safe directory listing marking git repos + branch from `.git/HEAD`, rooted at `fsRoot`; file read/download; write/upload into cwd or build an image block; path-traversal guard) → **Task 5**, wired in **Task 10**. ✓
- **`createServer(config, sessionManager)` returning a Fastify instance** → **Task 8** (returns `{ app, hub, authGate }` so later tasks/tests reach the hub); **entry that starts it** (`startServer`) → **Task 11**. ✓
- **Integration tests against the interactive mock, localhost only** (create → WS subscribe → message → streamed events + result → permission round-trip → reconnect replay) → **Task 11** (+ focused REST/WS/files tests in Tasks 8–10). No real `claude`, no external network. ✓
- **Security baseline — honest scope (spec §9 partially delivered).** Enforcement IS here (refuse non-loopback w/o token; constant-time compare; WS upgrade gated by the global preHandler) and is called out as such; **but** (a) a loopback/dev run with NO token is intentionally allowed (tokenless), and (b) first-run token **generation + persistence** is **deferred to Plan 4** (couples to SQLite). The Global Constraints "Security" block states this unmissably so no reader assumes §9 is fully done. `--dangerously-skip-permissions` per-session opt-in flows through `POST /sessions` + `SessionMeta.dangerouslySkip`. → Tasks 3, 4, 8, 9, 11 + Global Constraints. ✓
- **Proxy lockout caveat (spec §9 reverse proxy).** The lockout `clientKey` is `request.ip`, which collapses to one key behind Caddy/Cloudflare → self-DoS; documented in Task 4 with a one-line config hook (`trustProxy` in `ServerRuntimeConfig`, wired into `Fastify({ trustProxy })` in Task 8) so `request.ip` follows `X-Forwarded-For`. Not over-built — a flag + note. → Tasks 3, 4, 8. ✓
- **Idempotency (spec §10 "idempotency guard on session create")** is NOT silently absent: `POST /sessions` is explicitly documented as non-idempotent here, with a rationale-backed deferral to Plan 4 (registry-backed `Idempotency-Key` dedupe) in the "Out of scope" section and on the route line. → Out-of-scope note + Task 8. ✓
- **No `ANTHROPIC_API_KEY`** (deleted in `ClaudeProcess.start()` from Plan 2, untouched; `loadServerConfig` never reads it, asserted by a test), **no `@anthropic-ai/*` dep** (only `@roamcode/protocol` + Fastify packages added; `ws`/`@types/ws` are devDeps), subscription auth only → Global Constraints + Tasks 3/8. ✓
- **Wire-format knowledge stays in `@roamcode/protocol`** (transport imports `buildImageBlock` and types; the hub/transport never parse/serialize raw lines — `ClaudeProcess` does that via the protocol package; `toContentBlocks` validates inbound `blocks` so arbitrary client JSON can't reach `serializeUserMessage` → claude stdin) → Tasks 5, 7, 9. ✓
- **Bin executability:** `dist/start.js` is shebanged via a two-entry `tsup.config.ts` (`banner: { js: "#!/usr/bin/env node" }` on the `start.ts` entry only; `index.js` stays shebang-free), verified by `head -1` in Task 11 Step 7. Final packaging (npx/Docker) → Plan 6. ✓
- **Explicitly out of scope, noted:** persistence/resume across restart + `--resume` + reading `~/.claude/projects/*.jsonl` + Web Push + `POST /sessions` idempotency + first-run token generation/persistence → Plan 4; PWA → Plan 5; distribution/Docker/README → Plan 6; idle reaping + WS delta-coalescing backpressure → deferred (while "never drop permission/result" IS implemented). "Session history" here is the in-memory replay buffer. ✓
- **Right-sized to 11 tasks**, each with an independently testable deliverable and its own red→green→commit cycle. ✓

**2. Placeholder scan:** No "TBD/TODO/implement later/add error handling" left as work-to-do. Every code step shows the complete file or the exact before/after edit. The two `eslint-disable-next-line no-console` comments in `start.ts` are intentional (the entry point legitimately logs to the console on boot/failure), not placeholders. The "ignore malformed client frames" / "unknown frame types are ignored" comments describe real, intentional defensive no-ops (spec §10), not deferred work. ✓

**3. Type consistency (names/signatures across tasks):**
- `DiagnosticEvent` — defined Task 2, consumed by the hub (Task 7) and tests. ✓
- `ServerRuntimeConfig` (`port`, `bindAddress`, `accessToken?`, `fsRoot`, `maxUploadBytes`, `trustProxy?`, `claude`) — defined Task 3, consumed by `createServer` (Tasks 8–10) and `startServer` (Task 11). `trustProxy?` is **optional**, so the inline config literals in the Task 8/9/11 tests (which omit it) still typecheck; `createServer` reads it as `config.trustProxy ?? false`. ✓
- `AuthGate` / `AuthCheckResult` / `extractBearerToken` — defined Task 4, consumed by the single global preHandler in Task 8 (`authGate.check(token, request.ip)`), which gates REST and the WS upgrade alike. ✓
- `FsService` methods (`resolveWithinRoot`, `listDirectory`, `readFileForDownload`, `writeUploadedFile`, `buildImageBlockFromUpload`) + `DirEntry`/`DirListing` — defined Task 5, consumed Task 10. ✓
- `ReplayBuffer` (`push`, `snapshot`, `since`, capacity counts non-critical) + `ServerFrame`/`ServerFrameKind`/`isCriticalKind` — defined Task 6, consumed Tasks 7, 9, 11. The `ServerFrame` shape `{ seq, kind, payload }` is the exact WS server→client contract used in every WS/integration test. ✓
- `SessionHub` (`createSession`, `listSessions`, `getSession`, `getHistory`, `subscribe(id, listener, sinceSeq?)`, `sendMessage`, `answerPermission`, `stopSession`) + `SessionMeta`/`SessionStatus`/`FrameListener`/`Subscription` — defined Task 7, consumed Tasks 8–11. `SessionMeta` fields (`id`, `cwd`, `model?`, `effort?`, `dangerouslySkip`, `status`, `createdAt`) match every REST assertion. ✓
- `createServer(config, sessionManager) → { app, hub, authGate }` (`CreateServerResult`) — defined Task 8, extended in place by Tasks 9–10, consumed by every transport/integration test and `startServer`. ✓
- `startServer(env?) → CreateServerResult & { url: string }` — defined Task 11. ✓
- Protocol names used exactly as exported (`parseLine`, `ProtocolParseError`, `buildImageBlock`, `serializeInitialize`, `serializeUserMessage`, `serializeHookPermissionResponse`, `serializeCanUseToolResponse`, `classifyPermissionRequest`; types `InboundEvent`, `ResultEvent`, `ContentBlock`, `ImageBlock`, `HookPermissionDecision`, `CanUseToolResult`) — verified against `packages/protocol/src/index.ts` and `types.ts`. ✓
- Existing server names used exactly (`SessionManager`, `SessionManagerDeps` with `spawnPrefixArgs`/`baseEnv`/`startTimeoutMs`, `Session`, `CreateSessionOptions`, `ClaudeProcess` events) — verified against `packages/server/src/*.ts`. ✓
- `import type` used for all type-only imports (required by `verbatimModuleSyntax: true`). The WS *plugin* is the default import from `@fastify/websocket`; the `WebSocket` class/type is imported from `ws` (a value in tests via `new WebSocket(...)`, a type in the handler signature) because `@fastify/websocket` is CommonJS and exposes no `WebSocket` named ESM export — verified empirically. ✓

---

## Notes carried to later plans

- **Plan 4 (persistence + push):** `SessionHub` is the natural seam to add SQLite-backed `SessionMeta` and `claude --resume <id>` respawn-on-message (a dead process currently marks the session `errored` and emits an `"exit"` frame — Plan 4 turns that into lazy resume). Full history from `~/.claude/projects/*.jsonl` replaces the in-memory `getHistory`. A `result` frame is the Web Push trigger.
- **Plan 5 (PWA):** the client contract is fixed here — REST shapes (`SessionMeta`, `DirListing`), the WS server→client `ServerFrame` (`{ seq, kind, payload }`), and the WS client→server frames (`{type:"user", content|blocks|text+images}` / `{type:"permission", requestId, decision, reason?}`). Auth: `Authorization: Bearer <token>` for REST, `?token=` (or the header) for the WS upgrade.
- **Backpressure refinement:** Task 6's buffer guarantees `permission`/`result` are never evicted; a future per-client send queue that coalesces partial `stream_event` deltas when a socket is slow (spec §10) can layer on top of `subscribe`'s listener without changing the buffer contract.
- **`answerCanUseTool`:** `ClaudeProcess` already exposes `answerCanUseTool` (Plan 2) for the `can_use_tool` permission shape; the WS inbound frame currently maps only the `hook_callback` decision (`allow`/`deny`). If a future transport surfaces `can_use_tool`, extend `handleClientFrame` to route a `{type:"permission", canUseTool:{...}}` variant to `hub` → `manager` → `process.answerCanUseTool`.
