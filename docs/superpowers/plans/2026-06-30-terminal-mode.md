# Terminal-mode Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second kind of session — a "terminal session" — that runs the real `claude` interactive TUI inside a tmux + node-pty PTY and renders it in the PWA with xterm.js, alongside the existing stream-json chat sessions.

**Architecture:** A session gains a `mode` field (`"chat"` | `"terminal"`), chosen at creation and fixed for life. Terminal sessions run `tmux new-session -A -s rc-<id> -- claude …` through node-pty; the server is a thin byte-bridge over a binary WebSocket. tmux owns persistence (survives client disconnect AND server/OTA restart), scrollback, and redraw-on-attach. node-pty is reached through an injectable `ptySpawn` seam so unit tests use a fake (no native module / no real tmux needed).

**Tech Stack:** TypeScript (Node 22, ESM), Fastify + `@fastify/websocket` + `ws`, `better-sqlite3`, `node-pty` (new native dep), React + `@xterm/xterm` + `@xterm/addon-fit`, vitest.

## Global Constraints

- Node `>=22`; ESM (`"type":"module"`); pnpm workspace. One line each below copied from the spec:
- Terminal launches `claude` directly (the TUI), NOT a bare shell, in the wizard-chosen cwd.
- Mode is FIXED per session (v1) — no in-session Chat↔Terminal handoff.
- `ANTHROPIC_API_KEY` is always deleted from the child env (subscription auth only).
- tmux session name is exactly `rc-<sessionId>`.
- Terminal mode is **default ON**; gated only by the existing access-token + origin + rate-limit. Graceful-degrade to OFF when tmux or node-pty is unavailable.
- Binary WS protocol: server→client = raw PTY bytes (binary frames); client→server = JSON text `{ "t":"i", "d":"<utf8>" }` (input) and `{ "t":"r", "c":<cols>, "r":<rows> }` (resize).
- Reuse existing injectable-deps style (constructor-injected seams) for testability; follow existing file/comment conventions.
- New server module names: `terminal-process.ts`, `terminal-manager.ts`. New web files: `ws/terminal-socket.ts`, `chat/TerminalView.tsx`, `chat/TerminalKeyBar.tsx`.
- The web wizard already uses `mode` for `"new"|"resume"`; the session KIND is carried as a separate field named `kind` (`"chat"|"terminal"`) in the wizard, mapped to the server's `mode` on submit.

---

### Task 1: Add `mode` to the session store

**Files:**
- Modify: `packages/server/src/session-store.ts`
- Test: `packages/server/test/session-store.mode.test.ts` (create)

**Interfaces:**
- Produces: `StoredSession.mode: "chat" | "terminal"` (defaults to `"chat"` for legacy rows). `upsert`/`get`/`list` round-trip it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/session-store.mode.test.ts
import { expect, test } from "vitest";
import { openSessionStore } from "../src/session-store.js";

function store() {
  return openSessionStore({ dbPath: ":memory:" });
}

test("mode round-trips and defaults to 'chat' for legacy rows", () => {
  const s = store();
  s.upsert({
    id: "t1", cwd: "/tmp", mode: "terminal", dangerouslySkip: false,
    status: "running", createdAt: 1, lastActivityAt: 1,
  });
  s.upsert({
    id: "c1", cwd: "/tmp", dangerouslySkip: false,
    status: "running", createdAt: 1, lastActivityAt: 1,
  } as never); // omit mode → legacy
  expect(s.get("t1")?.mode).toBe("terminal");
  expect(s.get("c1")?.mode).toBe("chat");
  expect(s.list().find((r) => r.id === "t1")?.mode).toBe("terminal");
  s.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/session-store.mode.test.ts`
Expected: FAIL — `mode` is not a property of `StoredSession` / not persisted.

- [ ] **Step 3: Implement minimal code**

In `session-store.ts`:
- Add to `StoredSession`: `mode: "chat" | "terminal";`
- Add to `Row`: `mode: string | null;`
- In `rowToSession`: `s.mode = r.mode === "terminal" ? "terminal" : "chat";` (place after the base object; treat NULL/unknown as `"chat"`).
- In the `CREATE TABLE` body add `mode TEXT NOT NULL DEFAULT 'chat'`.
- Add a migration after the `context_window` one:

```ts
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'");
  } catch {
    // column already exists — nothing to do
  }
```

- Add `mode` to the `upsertStmt` INSERT column list + `VALUES (@... , @mode)` + the `ON CONFLICT … DO UPDATE SET mode=excluded.mode`, and pass `mode: s.mode ?? "chat"` in the `upsert` run object.
- The base `StoredSession` in `rowToSession` must set `mode`; in the `inMemoryStore`, `upsert` already spreads `{ ...s }` — ensure callers pass `mode` (default `"chat"` when absent): change `upsert: (s) => void map.set(s.id, { mode: "chat", ...s })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/session-store.mode.test.ts`
Expected: PASS

- [ ] **Step 5: Run the existing store test to confirm no regression**

Run: `npx vitest run packages/server/test/session-store.permission-mode.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/session-store.ts packages/server/test/session-store.mode.test.ts
git commit -m "feat(server): persist session mode (chat|terminal) in the store"
```

---

### Task 2: `TerminalProcess` — the tmux + node-pty bridge

**Files:**
- Create: `packages/server/src/terminal-process.ts`
- Test: `packages/server/test/terminal-process.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface IPty { onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(c: number, r: number): void; kill(sig?: string): void; }`
  - `type PtySpawn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => IPty;`
  - `interface TerminalProcessOptions { sessionId: string; cwd: string; tmuxBin?: string; claudeBin: string; claudeArgs?: string[]; cols?: number; rows?: number; env?: NodeJS.ProcessEnv; ptySpawn?: PtySpawn; runTmux?: (args: string[]) => void; }`
  - `class TerminalProcess extends EventEmitter` with `start(): void`, `write(d: string): void`, `resize(c: number, r: number): void`, `stop(opts?: { kill?: boolean }): void`, `readonly tmuxName: string`, events `"data"(chunk: string)` and `"exit"({ exitCode })`.
  - `export function tmuxSessionName(id: string): string` → `` `rc-${id}` ``.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/terminal-process.test.ts
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { TerminalProcess, tmuxSessionName } from "../src/terminal-process.js";

function fakePty() {
  const ee = new EventEmitter();
  const calls: { write: string[]; resize: [number, number][]; killed: number } = { write: [], resize: [], killed: 0 };
  const pty = {
    onData: (cb: (d: string) => void) => ee.on("data", cb),
    onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
    write: (d: string) => calls.write.push(d),
    resize: (c: number, r: number) => calls.resize.push([c, r]),
    kill: () => void (calls.killed += 1),
    emitData: (d: string) => ee.emit("data", d),
    emitExit: (code: number) => ee.emit("exit", { exitCode: code }),
  };
  return { pty, calls };
}

test("start spawns tmux new -A -s rc-<id> -- claude and bridges data", () => {
  const { pty } = fakePty();
  const spawn = vi.fn(() => pty);
  const runTmux = vi.fn();
  const tp = new TerminalProcess({
    sessionId: "abc", cwd: "/work", claudeBin: "/bin/claude",
    cols: 100, rows: 30, ptySpawn: spawn as never, runTmux,
  });
  const seen: string[] = [];
  tp.on("data", (d) => seen.push(d));
  tp.start();

  expect(tmuxSessionName("abc")).toBe("rc-abc");
  const [file, args, opts] = spawn.mock.calls[0]!;
  expect(file).toBe("tmux");
  expect(args).toEqual(["new-session", "-A", "-s", "rc-abc", "-x", "100", "-y", "30", "--", "/bin/claude"]);
  expect(opts).toMatchObject({ name: "xterm-256color", cwd: "/work", cols: 100, rows: 30 });
  expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  // remain-on-exit set out-of-band so an accidental claude exit doesn't destroy the session
  expect(runTmux).toHaveBeenCalledWith(["set-option", "-t", "rc-abc", "remain-on-exit", "on"]);

  pty.emitData("hello");
  expect(seen).toEqual(["hello"]);
});

test("write + resize forward to the pty; stop(kill) kills tmux session", () => {
  const { pty, calls } = fakePty();
  const runTmux = vi.fn();
  const tp = new TerminalProcess({
    sessionId: "z", cwd: "/w", claudeBin: "claude", ptySpawn: (() => pty) as never, runTmux,
  });
  tp.start();
  tp.write("ls\n");
  tp.resize(80, 24);
  expect(calls.write).toEqual(["ls\n"]);
  expect(calls.resize).toEqual([[80, 24]]);

  tp.stop({ kill: true });
  expect(runTmux).toHaveBeenCalledWith(["kill-session", "-t", "rc-z"]);
  expect(calls.killed).toBe(1);
});

test("exit is re-emitted", () => {
  const { pty } = fakePty();
  const tp = new TerminalProcess({ sessionId: "e", cwd: "/w", claudeBin: "claude", ptySpawn: (() => pty) as never, runTmux: () => {} });
  const exits: number[] = [];
  tp.on("exit", (e) => exits.push(e.exitCode));
  tp.start();
  pty.emitExit(0);
  expect(exits).toEqual([0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/terminal-process.test.ts`
Expected: FAIL — module `../src/terminal-process.js` not found.

- [ ] **Step 3: Implement `terminal-process.ts`**

```ts
// packages/server/src/terminal-process.ts
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

export interface IPty {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(sig?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => IPty;

export interface TerminalProcessOptions {
  sessionId: string;
  cwd: string;
  claudeBin: string;
  claudeArgs?: string[];
  tmuxBin?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable PTY spawner (default loads node-pty). Tests pass a fake. */
  ptySpawn?: PtySpawn;
  /** Injectable one-shot tmux command runner (set-option / kill-session). Default spawnSync(tmuxBin). */
  runTmux?: (args: string[]) => void;
}

/** The tmux session name for a remote-coder session id. Stable so attach/kill always target the same one. */
export function tmuxSessionName(id: string): string {
  return `rc-${id}`;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class TerminalProcess extends EventEmitter {
  readonly tmuxName: string;
  private readonly opts: TerminalProcessOptions;
  private pty?: IPty;
  private started = false;
  private readonly tmuxBin: string;
  private readonly runTmux: (args: string[]) => void;
  private readonly ptySpawn: PtySpawn;

  constructor(opts: TerminalProcessOptions) {
    super();
    this.opts = opts;
    this.tmuxName = tmuxSessionName(opts.sessionId);
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.runTmux = opts.runTmux ?? ((args) => void spawnSync(this.tmuxBin, args, { stdio: "ignore" }));
    this.ptySpawn = opts.ptySpawn ?? defaultPtySpawn;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const cols = this.opts.cols ?? 80;
    const rows = this.opts.rows ?? 24;
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    delete env.ANTHROPIC_API_KEY;
    const args = [
      "new-session", "-A", "-s", this.tmuxName,
      "-x", String(cols), "-y", String(rows),
      "--", this.opts.claudeBin, ...(this.opts.claudeArgs ?? []),
    ];
    const pty = this.ptySpawn(this.tmuxBin, args, { name: "xterm-256color", cols, rows, cwd: this.opts.cwd, env });
    this.pty = pty;
    pty.onData((d) => this.emit("data", d));
    pty.onExit((e) => this.emit("exit", e));
    // Keep the session alive if claude exits, so an accidental exit leaves a restartable pane.
    this.runTmux(["set-option", "-t", this.tmuxName, "remain-on-exit", "on"]);
  }

  write(d: string): void {
    this.pty?.write(d);
  }

  resize(c: number, r: number): void {
    this.pty?.resize(c, r);
  }

  /** Detach (kill the pty client; tmux + claude keep running). `kill:true` also kills the tmux session. */
  stop(opts: { kill?: boolean } = {}): void {
    if (opts.kill) this.runTmux(["kill-session", "-t", this.tmuxName]);
    try {
      this.pty?.kill();
    } catch {
      // pty already gone — best-effort
    }
    this.pty = undefined;
  }
}

/** Default spawner: lazy-load node-pty so a missing native module never breaks module import. */
const defaultPtySpawn: PtySpawn = (file, args, opts) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, opts) as unknown as IPty;
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface TerminalProcess {
  on(event: "data", listener: (chunk: string) => void): this;
  on(event: "exit", listener: (info: { exitCode: number }) => void): this;
  emit(event: "data", chunk: string): boolean;
  emit(event: "exit", info: { exitCode: number }): boolean;
}
```

Add at the top of the file (ESM `require` shim, mirroring `session-store.ts`):

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/terminal-process.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/terminal-process.ts packages/server/test/terminal-process.test.ts
git commit -m "feat(server): TerminalProcess — tmux + node-pty bridge (injectable, testable)"
```

---

### Task 3: Terminal capability detection

**Files:**
- Create: `packages/server/src/terminal-capability.ts`
- Test: `packages/server/test/terminal-capability.test.ts`

**Interfaces:**
- Produces: `function detectTerminalSupport(deps?: { hasTmux?: () => boolean; hasPty?: () => boolean }): boolean` — true only when BOTH tmux is on PATH AND node-pty loads.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/terminal-capability.test.ts
import { expect, test } from "vitest";
import { detectTerminalSupport } from "../src/terminal-capability.js";

test("true only when tmux AND pty are available", () => {
  expect(detectTerminalSupport({ hasTmux: () => true, hasPty: () => true })).toBe(true);
  expect(detectTerminalSupport({ hasTmux: () => false, hasPty: () => true })).toBe(false);
  expect(detectTerminalSupport({ hasTmux: () => true, hasPty: () => false })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/terminal-capability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/terminal-capability.ts
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function tmuxOnPath(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function ptyLoads(): boolean {
  try {
    require.resolve("node-pty");
    return true;
  } catch {
    return false;
  }
}

/** Terminal mode needs BOTH a tmux binary and a loadable node-pty. Injectable for tests. */
export function detectTerminalSupport(
  deps: { hasTmux?: () => boolean; hasPty?: () => boolean } = {},
): boolean {
  return (deps.hasTmux ?? tmuxOnPath)() && (deps.hasPty ?? ptyLoads)();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/terminal-capability.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/terminal-capability.ts packages/server/test/terminal-capability.test.ts
git commit -m "feat(server): detect terminal-mode support (tmux + node-pty)"
```

---

### Task 4: `TerminalManager` — lifecycle, fan-out, rehydration

**Files:**
- Create: `packages/server/src/terminal-manager.ts`
- Test: `packages/server/test/terminal-manager.test.ts`

**Interfaces:**
- Consumes: `TerminalProcess`, `PtySpawn` (Task 2); `SessionStore`, `StoredSession` (Task 1).
- Produces:
  - `interface TerminalMeta { id: string; cwd: string; mode: "terminal"; status: "running" | "ended"; createdAt: number; lastActivityAt: number; }`
  - `interface TerminalSub { unsubscribe(): void; }`
  - `class TerminalManager` with:
    - `create(opts: { id: string; cwd: string; claudeArgs?: string[]; cols?: number; rows?: number }): TerminalMeta`
    - `attach(id: string, onData: (chunk: string) => void): TerminalSub | undefined` (spawns the pty on first subscriber, replays nothing — tmux redraws; fans data to all subs)
    - `write(id: string, data: string): void`
    - `resize(id: string, cols: number, rows: number): void`
    - `stop(id: string): void` (kill-session + remove)
    - `get(id: string): TerminalMeta | undefined`
    - `list(): TerminalMeta[]`
    - `rehydrate(opts: { liveTmuxNames: string[] }): void` (from store rows mode='terminal' whose `rc-<id>` is in liveTmuxNames)
  - constructor deps: `{ store: SessionStore; claudeBin: string; now: () => number; ptySpawn?: PtySpawn; runTmux?: (args: string[]) => void; env?: NodeJS.ProcessEnv }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/terminal-manager.test.ts
import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import { TerminalManager } from "../src/terminal-manager.js";
import { openSessionStore } from "../src/session-store.js";

function fakePtyFactory() {
  const ptys: EventEmitter[] = [];
  const spawn = () => {
    const ee = new EventEmitter() as EventEmitter & { write(d: string): void; resize(c: number, r: number): void; kill(): void; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void };
    ee.write = () => {};
    ee.resize = () => {};
    ee.kill = () => {};
    ee.onData = (cb) => void ee.on("data", cb);
    ee.onExit = (cb) => void ee.on("exit", cb);
    ptys.push(ee);
    return ee;
  };
  return { spawn, ptys };
}

function mgr() {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  let t = 0;
  const m = new TerminalManager({ store, claudeBin: "claude", now: () => ++t, ptySpawn: spawn as never, runTmux: () => {} });
  return { m, store, ptys };
}

test("create persists a terminal row; attach spawns pty and fans data", () => {
  const { m, store, ptys } = mgr();
  const meta = m.create({ id: "s1", cwd: "/w" });
  expect(meta.mode).toBe("terminal");
  expect(store.get("s1")?.mode).toBe("terminal");

  const seen: string[] = [];
  const sub = m.attach("s1", (d) => seen.push(d));
  expect(sub).toBeDefined();
  ptys[0]!.emit("data", "redraw");
  expect(seen).toEqual(["redraw"]);
});

test("rehydrate marks stored terminal sessions whose tmux session is alive", () => {
  const { m, store } = mgr();
  store.upsert({ id: "old", cwd: "/w", mode: "terminal", dangerouslySkip: false, status: "running", createdAt: 1, lastActivityAt: 1 });
  m.rehydrate({ liveTmuxNames: ["rc-old"] });
  expect(m.get("old")?.status).toBe("running");
});

test("stop kills and removes", () => {
  const { m } = mgr();
  m.create({ id: "x", cwd: "/w" });
  m.attach("x", () => {});
  m.stop("x");
  expect(m.get("x")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/terminal-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `terminal-manager.ts`**

```ts
// packages/server/src/terminal-manager.ts
import { TerminalProcess, tmuxSessionName, type PtySpawn } from "./terminal-process.js";
import type { SessionStore } from "./session-store.js";

export interface TerminalMeta {
  id: string;
  cwd: string;
  mode: "terminal";
  status: "running" | "ended";
  createdAt: number;
  lastActivityAt: number;
}

export interface TerminalSub {
  unsubscribe(): void;
}

interface Record_ {
  meta: TerminalMeta;
  claudeArgs: string[];
  cols: number;
  rows: number;
  proc?: TerminalProcess;
  subs: Set<(chunk: string) => void>;
}

export interface TerminalManagerDeps {
  store: SessionStore;
  claudeBin: string;
  now: () => number;
  ptySpawn?: PtySpawn;
  runTmux?: (args: string[]) => void;
  env?: NodeJS.ProcessEnv;
}

export class TerminalManager {
  private readonly records = new Map<string, Record_>();
  constructor(private readonly deps: TerminalManagerDeps) {}

  create(opts: { id: string; cwd: string; claudeArgs?: string[]; cols?: number; rows?: number }): TerminalMeta {
    const now = this.deps.now();
    const meta: TerminalMeta = {
      id: opts.id, cwd: opts.cwd, mode: "terminal", status: "running", createdAt: now, lastActivityAt: now,
    };
    this.records.set(opts.id, {
      meta, claudeArgs: opts.claudeArgs ?? [], cols: opts.cols ?? 80, rows: opts.rows ?? 24, subs: new Set(),
    });
    this.deps.store.upsert({
      id: opts.id, cwd: opts.cwd, mode: "terminal", dangerouslySkip: false,
      status: "running", createdAt: now, lastActivityAt: now,
    });
    return meta;
  }

  attach(id: string, onData: (chunk: string) => void): TerminalSub | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    rec.subs.add(onData);
    if (!rec.proc) {
      const proc = new TerminalProcess({
        sessionId: id, cwd: rec.meta.cwd, claudeBin: this.deps.claudeBin,
        claudeArgs: rec.claudeArgs, cols: rec.cols, rows: rec.rows,
        ...(this.deps.env ? { env: this.deps.env } : {}),
        ...(this.deps.ptySpawn ? { ptySpawn: this.deps.ptySpawn } : {}),
        ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
      });
      proc.on("data", (chunk) => {
        for (const cb of rec.subs) cb(chunk);
      });
      proc.on("exit", () => {
        rec.meta.status = "ended";
      });
      rec.proc = proc;
      proc.start();
    }
    return {
      unsubscribe: () => {
        rec.subs.delete(onData);
        // No subscribers left → detach the pty client; tmux + claude keep running for reconnect.
        if (rec.subs.size === 0 && rec.proc) {
          rec.proc.stop();
          rec.proc = undefined;
        }
      },
    };
  }

  write(id: string, data: string): void {
    const rec = this.records.get(id);
    rec?.proc?.write(data);
    if (rec) {
      rec.meta.lastActivityAt = this.deps.now();
      this.deps.store.touch(id, rec.meta.lastActivityAt);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.cols = cols;
    rec.rows = rows;
    rec.proc?.resize(cols, rows);
  }

  stop(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (rec.proc) rec.proc.stop({ kill: true });
    else new TerminalProcess({ sessionId: id, cwd: rec.meta.cwd, claudeBin: this.deps.claudeBin, ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}) }).stop({ kill: true });
    this.records.delete(id);
    this.deps.store.delete(id);
  }

  get(id: string): TerminalMeta | undefined {
    return this.records.get(id)?.meta;
  }

  list(): TerminalMeta[] {
    return [...this.records.values()].map((r) => r.meta);
  }

  /** Re-list stored terminal sessions whose tmux session is still alive (after a server/OTA restart). */
  rehydrate(opts: { liveTmuxNames: string[] }): void {
    const live = new Set(opts.liveTmuxNames);
    for (const s of this.deps.store.list()) {
      if (s.mode !== "terminal") continue;
      if (!live.has(tmuxSessionName(s.id))) {
        this.deps.store.delete(s.id); // tmux session gone → prune the stale row
        continue;
      }
      if (this.records.has(s.id)) continue;
      this.records.set(s.id, {
        meta: { id: s.id, cwd: s.cwd, mode: "terminal", status: "running", createdAt: s.createdAt, lastActivityAt: s.lastActivityAt },
        claudeArgs: [], cols: 80, rows: 24, subs: new Set(),
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/terminal-manager.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/terminal-manager.ts packages/server/test/terminal-manager.test.ts
git commit -m "feat(server): TerminalManager — lifecycle, fan-out, rehydration"
```

---

### Task 5: List live tmux sessions (for rehydration + capability wiring)

**Files:**
- Create: `packages/server/src/tmux-list.ts`
- Test: `packages/server/test/tmux-list.test.ts`

**Interfaces:**
- Produces: `function listTmuxSessions(runTmuxOut?: () => string): string[]` — parses `tmux list-sessions -F '#{session_name}'` output into names; `[]` on error/empty.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/tmux-list.test.ts
import { expect, test } from "vitest";
import { listTmuxSessions } from "../src/tmux-list.js";

test("parses session names; tolerates blank/error", () => {
  expect(listTmuxSessions(() => "rc-a\nrc-b\nother\n")).toEqual(["rc-a", "rc-b", "other"]);
  expect(listTmuxSessions(() => "")).toEqual([]);
  expect(listTmuxSessions(() => { throw new Error("no server"); })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/tmux-list.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/tmux-list.ts
import { spawnSync } from "node:child_process";

function defaultRun(): string {
  const r = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : "";
}

/** Live tmux session names. Injectable runner for tests. Returns [] when tmux has no server / errors. */
export function listTmuxSessions(runTmuxOut: () => string = defaultRun): string[] {
  let out: string;
  try {
    out = runTmuxOut();
  } catch {
    return [];
  }
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/tmux-list.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tmux-list.ts packages/server/test/tmux-list.test.ts
git commit -m "feat(server): list live tmux sessions for terminal rehydration"
```

---

### Task 6: Add node-pty + xterm dependencies

**Files:**
- Modify: `packages/server/package.json` (dependencies)
- Modify: `packages/web/package.json` (dependencies)

**Interfaces:** none (build/runtime wiring only).

- [ ] **Step 1: Add the server dep**

Run:
```bash
pnpm --filter @remote-coder/server add node-pty@1.1.0
```
Expected: `node-pty` appears under `packages/server/package.json` dependencies; pnpm fetches a prebuilt binary.

- [ ] **Step 2: Add the web deps**

Run:
```bash
pnpm --filter @remote-coder/web add @xterm/xterm@5 @xterm/addon-fit@0.10
```
(Use the latest published majors that resolve; the spec referenced @xterm/xterm 6.0.0 — if `add` resolves 6.x, that's fine. Pin whatever resolves.)

- [ ] **Step 3: Verify install + that node-pty loads**

Run:
```bash
node -e "require('packages/server/node_modules/node-pty'); console.log('node-pty ok')"
```
Expected: `node-pty ok` (no native build error). If it fails, STOP and report — Task 3's capability gate will hide the feature, but the dep must at least install.

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json packages/web/package.json pnpm-lock.yaml
git commit -m "build: add node-pty (server) + xterm (web) for terminal mode"
```

---

### Task 7: Server transport — create terminal sessions + capability flag

**Files:**
- Modify: `packages/server/src/transport.ts` (`CreateSessionBody`, POST `/sessions`, `GET /version` or a new field; construct `TerminalManager`; rehydrate on boot)
- Test: `packages/server/test/transport.terminal.test.ts`

**Interfaces:**
- Consumes: `TerminalManager` (Task 4), `detectTerminalSupport` (Task 3), `listTmuxSessions` (Task 5).
- Produces: `POST /sessions { mode:"terminal", cwd }` → 201 `{ id, mode:"terminal", … }`; `GET /version` response gains `terminalAvailable: boolean`; on boot the manager is rehydrated.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/transport.terminal.test.ts
import { expect, test } from "vitest";
// Reuse the project's existing transport test harness/helpers. Build a server with terminal support
// forced ON via an injected detector and a fake ptySpawn/runTmux through the SessionManager deps.
// (Follow the pattern in transport.ws.test.ts / transport.resume.test.ts for server construction.)
import { buildTestServer } from "./helpers/test-server.js"; // create if absent (thin wrapper around createServer)

test("POST /sessions {mode:'terminal'} creates a terminal session", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });
  const res = await app.inject({
    method: "POST", url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { cwd: process.cwd(), mode: "terminal" },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().mode).toBe("terminal");
  await app.close();
});

test("terminal create is rejected when unsupported", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: false });
  const res = await app.inject({
    method: "POST", url: "/sessions",
    headers: { authorization: `Bearer ${token}` },
    payload: { cwd: process.cwd(), mode: "terminal" },
  });
  expect(res.statusCode).toBe(400);
  await app.close();
});

test("GET /version reports terminalAvailable", async () => {
  const { app, token } = await buildTestServer({ terminalAvailable: true });
  const res = await app.inject({ method: "GET", url: "/version", headers: { authorization: `Bearer ${token}` } });
  expect(res.json().terminalAvailable).toBe(true);
  await app.close();
});
```

If `helpers/test-server.js` does not exist, create it as a thin wrapper that calls `createServer` with an injected `terminalManager` (fake `ptySpawn`/`runTmux`) and a `terminalAvailable` override, mirroring how `transport.ws.test.ts` constructs its server. Keep the wrapper under 40 lines.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/transport.terminal.test.ts`
Expected: FAIL — `mode` not handled / `terminalAvailable` absent.

- [ ] **Step 3: Implement transport changes**

In `transport.ts`:
- Add to `CreateSessionBody`: `mode?: "chat" | "terminal";`
- Add a `CreateServerDeps` field: `terminalManager?: TerminalManager;` and `terminalAvailable?: boolean;` (injectable; default real).
- Construct the manager near `hub`:

```ts
const terminalAvailable = deps.terminalAvailable ?? detectTerminalSupport();
const terminalManager =
  deps.terminalManager ??
  new TerminalManager({ store: deps.store ?? /* same store the hub uses */ undefined as never, claudeBin: config.claude.claudeBin, now: () => Date.now() });
```
(Use the SAME `SessionStore` instance the hub was given so the unified list stays consistent; if the hub owns the store internally, expose it or pass `deps.store` through — see Task 8 for the unified-list seam. If `deps.store` is undefined in production, construct the store once in `createServer` and pass it to BOTH the hub and the manager.)

- On boot, after `hub.loadFromStore()`:

```ts
if (terminalAvailable) terminalManager.rehydrate({ liveTmuxNames: listTmuxSessions() });
```

- In `POST /sessions`, before the resume/chat branches:

```ts
if (body.mode === "terminal") {
  if (!terminalAvailable) {
    reply.code(400).send({ error: "terminal mode unavailable", hint: "install tmux on the host (and ensure node-pty loads)" });
    return;
  }
  if (typeof body.cwd !== "string") {
    reply.code(400).send({ error: "cwd is required" });
    return;
  }
  const id = randomUUID(); // import { randomUUID } from "node:crypto" if not already
  const claudeArgs: string[] = [];
  if (typeof body.model === "string") claudeArgs.push("--model", body.model);
  if (typeof body.permissionMode === "string") claudeArgs.push("--permission-mode", body.permissionMode);
  const meta = terminalManager.create({ id, cwd: body.cwd, claudeArgs });
  reply.code(201).send({ id: meta.id, cwd: meta.cwd, mode: "terminal", status: meta.status, createdAt: meta.createdAt, dangerouslySkip: false });
  return;
}
```

- In the `GET /version` handler, add `terminalAvailable` to the response object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/transport.terminal.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full server transport suite (no regression)**

Run: `npx vitest run packages/server/test/transport.*.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/transport.ts packages/server/test/transport.terminal.test.ts packages/server/test/helpers/test-server.ts
git commit -m "feat(server): create terminal sessions + terminalAvailable in /version"
```

---

### Task 8: Server transport — binary terminal WebSocket + unified session list

**Files:**
- Modify: `packages/server/src/transport.ts` (new WS route; merge terminal sessions into the list endpoint)
- Test: `packages/server/test/transport.terminal-ws.test.ts`

**Interfaces:**
- Consumes: `TerminalManager.attach/write/resize` (Task 4).
- Produces: WS route `GET /sessions/:id/terminal` (binary out / JSON in); the sessions LIST endpoint includes terminal sessions with `mode:"terminal"`.

- [ ] **Step 1: Write the failing test** (drive a fake pty through the manager, assert output is sent binary and input/resize reach the manager)

```ts
// packages/server/test/transport.terminal-ws.test.ts
import { expect, test } from "vitest";
import { buildTestServer } from "./helpers/test-server.js";

test("terminal WS streams pty output (binary) and forwards input/resize", async () => {
  const { app, token, fakePty } = await buildTestServer({ terminalAvailable: true });
  const create = await app.inject({ method: "POST", url: "/sessions", headers: { authorization: `Bearer ${token}` }, payload: { cwd: process.cwd(), mode: "terminal" } });
  const id = create.json().id;

  // Use the app's injected ws test client (mirror transport.ws.test.ts). Connect to /sessions/:id/terminal?token=...
  const ws = await app.wsConnect(`/sessions/${id}/terminal?token=${token}`);
  const got: Buffer[] = [];
  ws.on("message", (m: Buffer) => got.push(m));

  fakePty.lastForId(id).emit("data", "screen-redraw");
  await ws.nextMessage();
  expect(Buffer.concat(got).toString()).toContain("screen-redraw");

  ws.send(JSON.stringify({ t: "i", d: "ls\n" }));
  ws.send(JSON.stringify({ t: "r", c: 120, r: 40 }));
  await ws.drain();
  expect(fakePty.writesFor(id)).toContain("ls\n");
  expect(fakePty.resizesFor(id)).toContainEqual([120, 40]);
  await app.close();
});
```

(Extend `helpers/test-server.ts` with `fakePty` accessors + a `wsConnect` helper modeled on the existing ws test utilities. If the existing ws tests use `ws` directly against a listening server, do the same here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/transport.terminal-ws.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement the WS route**

Inside the same `app.register(async (wsScope) => { … })` block that holds `/sessions/:id/ws`, add:

```ts
wsScope.get<{ Params: { id: string } }>(
  "/sessions/:id/terminal",
  { websocket: true },
  (socket: WebSocket, request: FastifyRequest<{ Params: { id: string } }>) => {
    const id = request.params.id;
    if (!terminalManager.get(id)) {
      socket.close(4404, "terminal session not found");
      return;
    }
    const sub = terminalManager.attach(id, (chunk) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(Buffer.from(chunk, "utf8")); // binary frame
      } catch {
        sub?.unsubscribe();
        try { socket.close(); } catch { /* already gone */ }
      }
    });
    if (!sub) {
      socket.close(4404, "terminal session not found");
      return;
    }
    socket.on("message", (raw: Buffer) => {
      let msg: { t?: string; d?: string; c?: number; r?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === "i" && typeof msg.d === "string") terminalManager.write(id, msg.d);
      else if (msg.t === "r" && typeof msg.c === "number" && typeof msg.r === "number") terminalManager.resize(id, msg.c, msg.r);
    });
    socket.on("close", () => sub.unsubscribe());
    socket.on("error", () => sub.unsubscribe());
  },
);
```

- Merge terminal sessions into the sessions LIST response: wherever the list endpoint maps `hub.listSessions()`, append `terminalManager.list()` mapped to the same list-item shape (id, cwd, mode:"terminal", status, createdAt, lastActivityAt). Ensure chat list items carry `mode:"chat"` so the client can branch.

- DELETE `/sessions/:id` and POST `/sessions/:id/stop`: if `terminalManager.get(id)` exists, call `terminalManager.stop(id)` and return 204/200 (don't route a terminal id into the chat hub).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/transport.terminal-ws.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `npx vitest run packages/server`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/transport.ts packages/server/test/transport.terminal-ws.test.ts packages/server/test/helpers/test-server.ts
git commit -m "feat(server): binary terminal WebSocket + unified session list"
```

---

### Task 9: Web — terminal socket client

**Files:**
- Create: `packages/web/src/ws/terminal-socket.ts`
- Test: `packages/web/src/ws/terminal-socket.test.ts`

**Interfaces:**
- Produces: `function createTerminalSocket(opts: { url: string; onData: (bytes: Uint8Array) => void; onStatus?: (s: "open"|"closed") => void }): { sendInput(d: string): void; sendResize(cols: number, rows: number): void; close(): void }` — opens a binary WS (`binaryType="arraybuffer"`), decodes incoming frames to bytes, sends `{t:"i"}`/`{t:"r"}` JSON.

- [ ] **Step 1: Write the failing test** (inject a fake WebSocket)

```ts
// packages/web/src/ws/terminal-socket.test.ts
import { expect, test, vi } from "vitest";
import { createTerminalSocket } from "./terminal-socket";

class FakeWS {
  static last: FakeWS;
  binaryType = "";
  sent: string[] = [];
  onmessage?: (e: { data: ArrayBuffer }) => void;
  onopen?: () => void;
  onclose?: () => void;
  constructor(public url: string) { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.(); }
}

test("decodes binary output and encodes input/resize", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const got: Uint8Array[] = [];
  const sock = createTerminalSocket({ url: "wss://x/sessions/a/terminal?token=t", onData: (b) => got.push(b) });
  FakeWS.last.onopen?.();
  FakeWS.last.onmessage?.({ data: new TextEncoder().encode("hi").buffer });
  expect(new TextDecoder().decode(got[0])).toBe("hi");

  sock.sendInput("x");
  sock.sendResize(80, 24);
  expect(JSON.parse(FakeWS.last.sent[0]!)).toEqual({ t: "i", d: "x" });
  expect(JSON.parse(FakeWS.last.sent[1]!)).toEqual({ t: "r", c: 80, r: 24 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/src/ws/terminal-socket.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/ws/terminal-socket.ts
export interface TerminalSocket {
  sendInput(d: string): void;
  sendResize(cols: number, rows: number): void;
  close(): void;
}

export function createTerminalSocket(opts: {
  url: string;
  onData: (bytes: Uint8Array) => void;
  onStatus?: (s: "open" | "closed") => void;
}): TerminalSocket {
  const ws = new WebSocket(opts.url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => opts.onStatus?.("open");
  ws.onclose = () => opts.onStatus?.("closed");
  ws.onmessage = (e: MessageEvent) => {
    if (e.data instanceof ArrayBuffer) opts.onData(new Uint8Array(e.data));
    else if (typeof e.data === "string") opts.onData(new TextEncoder().encode(e.data));
  };
  const send = (o: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };
  return {
    sendInput: (d) => send({ t: "i", d }),
    sendResize: (cols, rows) => send({ t: "r", c: cols, r: rows }),
    close: () => ws.close(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/src/ws/terminal-socket.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/ws/terminal-socket.ts packages/web/src/ws/terminal-socket.test.ts
git commit -m "feat(web): terminal WebSocket client (binary out, JSON in)"
```

---

### Task 10: Web — `TerminalKeyBar` (mobile keys)

**Files:**
- Create: `packages/web/src/chat/TerminalKeyBar.tsx`
- Create: `packages/web/src/chat/terminal-keys.ts` (pure sequence map)
- Test: `packages/web/src/chat/terminal-keys.test.ts`

**Interfaces:**
- Produces: `const KEY_SEQUENCES: Record<string,string>` and `function ctrlSeq(ch: string): string` (e.g. `ctrlSeq("c") === "\x03"`); `TerminalKeyBar` component `({ onSend(seq: string): void })` rendering the key buttons (sticky Ctrl modifier).

- [ ] **Step 1: Write the failing test** (pure sequence logic only — the component is exercised in Task 11's view test)

```ts
// packages/web/src/chat/terminal-keys.test.ts
import { expect, test } from "vitest";
import { KEY_SEQUENCES, ctrlSeq } from "./terminal-keys";

test("escape sequences are correct", () => {
  expect(KEY_SEQUENCES.Esc).toBe("\x1b");
  expect(KEY_SEQUENCES.Tab).toBe("\t");
  expect(KEY_SEQUENCES.ArrowUp).toBe("\x1b[A");
  expect(KEY_SEQUENCES.ArrowDown).toBe("\x1b[B");
  expect(KEY_SEQUENCES.ArrowRight).toBe("\x1b[C");
  expect(KEY_SEQUENCES.ArrowLeft).toBe("\x1b[D");
});

test("ctrl maps a-z to control bytes", () => {
  expect(ctrlSeq("c")).toBe("\x03");
  expect(ctrlSeq("C")).toBe("\x03");
  expect(ctrlSeq("d")).toBe("\x04");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/src/chat/terminal-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `terminal-keys.ts`**

```ts
// packages/web/src/chat/terminal-keys.ts
export const KEY_SEQUENCES: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\t",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  "|": "|",
  "~": "~",
  "/": "/",
  "-": "-",
};

/** Control byte for a letter: Ctrl-C → 0x03, Ctrl-D → 0x04, … (uppercase-insensitive). */
export function ctrlSeq(ch: string): string {
  const c = ch.toLowerCase().charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
  return ch;
}
```

- [ ] **Step 4: Implement `TerminalKeyBar.tsx`**

```tsx
// packages/web/src/chat/TerminalKeyBar.tsx
import { useState } from "react";
import { KEY_SEQUENCES, ctrlSeq } from "./terminal-keys";

/** Mobile helper row: the TUI keys a phone keyboard lacks. `Ctrl` is a sticky modifier applied to the
 *  next ordinary key (or the explicit Ctrl-C/Ctrl-D buttons). Emits raw sequences via onSend. */
export function TerminalKeyBar({ onSend }: { onSend: (seq: string) => void }) {
  const [ctrl, setCtrl] = useState(false);
  const tap = (label: string) => {
    const base = KEY_SEQUENCES[label] ?? label;
    onSend(ctrl ? ctrlSeq(base) : base);
    if (ctrl) setCtrl(false);
  };
  const keys = ["Esc", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "|", "~", "/", "-"];
  return (
    <div className="rc-termkeys" role="toolbar" aria-label="Terminal keys">
      <button type="button" aria-pressed={ctrl} className={ctrl ? "rc-termkeys__ctrl is-on" : "rc-termkeys__ctrl"} onClick={() => setCtrl((v) => !v)}>Ctrl</button>
      {keys.map((k) => (
        <button type="button" key={k} aria-label={k} onClick={() => tap(k)}>{labelFor(k)}</button>
      ))}
      <button type="button" aria-label="Ctrl-C" onClick={() => onSend(ctrlSeq("c"))}>^C</button>
      <button type="button" aria-label="Ctrl-D" onClick={() => onSend(ctrlSeq("d"))}>^D</button>
    </div>
  );
}

function labelFor(k: string): string {
  return { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[k] ?? k;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/src/chat/terminal-keys.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/chat/TerminalKeyBar.tsx packages/web/src/chat/terminal-keys.ts packages/web/src/chat/terminal-keys.test.ts
git commit -m "feat(web): TerminalKeyBar — mobile TUI key sequences"
```

---

### Task 11: Web — `TerminalView` (xterm) + routing + wizard + SessionList

**Files:**
- Create: `packages/web/src/chat/TerminalView.tsx`
- Test: `packages/web/src/chat/TerminalView.test.tsx`
- Modify: `packages/web/src/session/NewSessionWizard.tsx` (add "Chat | Terminal" kind toggle on the `new` flow; pass `mode` to createSession)
- Modify: `packages/web/src/api/client.ts` (`CreateSessionBody.mode`; terminal WS url helper; `VersionInfo.terminalAvailable`)
- Modify: `packages/web/src/App.tsx` (render `TerminalView` when active session `mode==="terminal"`)
- Modify: `packages/web/src/session/SessionList.tsx` (terminal glyph + live/ended state)
- Modify: `packages/web/src/types/server.ts` (`SessionMeta.mode`, `VersionInfo.terminalAvailable`)

**Interfaces:**
- Consumes: `createTerminalSocket` (Task 9), `TerminalKeyBar` (Task 10), `terminalWsUrl` (added to client.ts), `VersionInfo.terminalAvailable` (Task 7).
- Produces: `TerminalView` component `({ sessionId: string })`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/chat/TerminalView.test.tsx
import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";

// Mock xterm so jsdom doesn't need a real canvas; assert we wire onData→socket and socket→term.write.
const writes: string[] = [];
const dataCbs: ((d: string) => void)[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80; rows = 24;
    loadAddon() {}
    open() {}
    write(d: string) { writes.push(typeof d === "string" ? d : new TextDecoder().decode(d)); }
    onData(cb: (d: string) => void) { dataCbs.push(cb); }
    onResize() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} activate() {} dispose() {} } }));

const sent: string[] = [];
vi.mock("../ws/terminal-socket", () => ({
  createTerminalSocket: (opts: { onData: (b: Uint8Array) => void }) => {
    setTimeout(() => opts.onData(new TextEncoder().encode("boot")), 0);
    return { sendInput: (d: string) => sent.push(d), sendResize: () => {}, close: () => {} };
  },
}));

import { TerminalView } from "./TerminalView";

test("pipes socket output into the terminal and input back to the socket", async () => {
  render(<TerminalView sessionId="s1" />);
  await new Promise((r) => setTimeout(r, 10));
  expect(writes.join("")).toContain("boot");
  dataCbs[0]!("k");
  expect(sent).toContain("k");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/src/chat/TerminalView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TerminalView.tsx`**

```tsx
// packages/web/src/chat/TerminalView.tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
import { terminalWsUrl } from "../api/client";
import { TerminalKeyBar } from "./TerminalKeyBar";

/** Renders a terminal session's claude TUI: xterm.js bridged to the binary terminal WebSocket. */
export function TerminalView({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<TerminalSocket | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: "#0b0e14" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const sock = createTerminalSocket({
      url: terminalWsUrl(sessionId),
      onData: (bytes) => term.write(bytes),
    });
    sockRef.current = sock;
    const offData = term.onData((d) => sock.sendInput(d));
    const sendSize = () => { fit.fit(); sock.sendResize(term.cols, term.rows); };
    const ro = new ResizeObserver(() => sendSize());
    ro.observe(host);
    sendSize();

    return () => {
      ro.disconnect();
      offData.dispose();
      sock.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="rc-terminal">
      <div className="rc-terminal__host" ref={hostRef} />
      <TerminalKeyBar onSend={(seq) => sockRef.current?.sendInput(seq)} />
    </div>
  );
}
```

- [ ] **Step 4: Add `terminalWsUrl` + `mode` to `client.ts`**

In `packages/web/src/api/client.ts`:
- Add `mode?: "chat" | "terminal";` to `CreateSessionBody`.
- Next to the existing `wsUrl` helper (line ~118), add:

```ts
export function terminalWsUrl(id: string): string {
  const qs = authQuery(); // reuse however wsUrl appends ?token= (mirror the existing helper)
  return `${wsBase}/sessions/${id}/terminal${qs ? `?${qs}` : ""}`;
}
```
(Reuse the SAME token-appending logic `wsUrl` uses; do not duplicate token handling — extract a shared `authQuery()` if needed.)

- [ ] **Step 5: Wire types, routing, wizard, list**

- `types/server.ts`: add `mode?: "chat" | "terminal"` to `SessionMeta` (default treated as "chat"); add `terminalAvailable?: boolean` to `VersionInfo`.
- `App.tsx`: where the active session renders `ChatView`, branch: `activeSession?.mode === "terminal" ? <TerminalView sessionId={activeSession.id} /> : <ChatView … />`.
- `NewSessionWizard.tsx`: on the `new` flow, add a segmented control (kind = "chat" | "terminal"), default "chat", shown only when `updateInfo?.terminalAvailable` (thread the flag in as a prop `terminalAvailable?: boolean`). On create, pass `mode: kind` to `api.createSession`. Use a DISTINCT state name (`kind`) — do NOT reuse the wizard's existing `mode` (new/resume).
- `SessionList.tsx`: for rows with `mode === "terminal"`, render a terminal glyph and a "live"/"ended" label instead of the chat wire state.

- [ ] **Step 6: Run the view test + web suite**

Run: `npx vitest run packages/web/src/chat/TerminalView.test.tsx`
Expected: PASS
Run: `npx vitest run packages/web`
Expected: PASS (fix any snapshot/markup assertions the new branches touched)

- [ ] **Step 7: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): TerminalView (xterm) + wizard kind toggle + routing + list rendering"
```

---

### Task 12: Full build, lint, typecheck + live smoke

**Files:** none (verification gate).

- [ ] **Step 1: Typecheck**

Run: `npx tsc -b --pretty`
Expected: exit 0.

- [ ] **Step 2: Lint**

Run: `npx eslint packages/server/src packages/web/src`
Expected: 0 errors.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all pass (1 pre-existing skip).

- [ ] **Step 4: Full build**

Run: `pnpm -r build`
Expected: web + server + cli build success.

- [ ] **Step 5: Live smoke (real tmux + real claude), isolated**

Manually verify on the box (the maintainer prefers live confirmation):
- Restart the server (or run a throwaway instance on a spare PORT pointing at a temp data dir).
- Create a terminal session via the API (`POST /sessions {mode:"terminal", cwd:<a temp dir>}`).
- Open the terminal WS, confirm the claude TUI renders, type input, resize, then disconnect.
- Reconnect → confirm the TUI screen redraws (persistence). `tmux ls` shows `rc-<id>`.
- Stop the session → `tmux ls` no longer lists it.

- [ ] **Step 6: Commit any fixes from the smoke**

```bash
git add -A
git commit -m "fix(terminal): live-smoke fixes"
```

---

## Self-Review notes (filled during writing)

- **Spec coverage:** mode field (T1), tmux+pty bridge (T2), capability detect (T3), lifecycle/fan-out/rehydration (T4), tmux list (T5), deps (T6), create + capability flag (T7), binary WS + unified list (T8), web socket (T9), key bar (T10), view/routing/wizard/list (T11), verification + live smoke (T12). Security: reuses existing gate (T7/T8 ride the global preHandler) + RCE note in the spec; default-ON via `terminalAvailable` with graceful degrade (T3/T7).
- **Open risk (flagged in spec):** node-pty native install (T6 Step 3 gates it). Fallback = tmux control-mode (no native dep) if node-pty proves unbuildable — would replace T2/T9's transport but keep the same UX.
- **Type consistency:** `mode:"chat"|"terminal"` used identically across store/meta/body; `tmuxSessionName`/`rc-<id>` shared by T2/T4/T5; `createTerminalSocket`/`terminalWsUrl` names match between T9 and T11.
