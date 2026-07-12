// packages/server/test/terminal-manager.test.ts
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalManager } from "../src/terminal-manager.js";
import { codexMcpTokenPathFor, hookAuthPathFor, hooksSettingsPathFor } from "../src/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { createCodexProvider } from "../src/providers/codex-provider.js";
import { createClaudeProvider } from "../src/providers/claude-provider.js";
import {
  CodexThreadResolver,
  resetCodexThreadResolutionCoordinatorForTests,
} from "../src/providers/codex-thread-resolver.js";
import {
  ProviderError,
  type AgentProvider,
  type ProcessSpec,
  type ProviderId,
  type ProviderProcessContext,
  type ProviderRuntimeSignal,
} from "../src/providers/types.js";
import { openSessionStore } from "../src/session-store.js";

const claudeRegistry = (claudeBin = "claude") => new ProviderRegistry([createClaudeProvider({ claudeBin })]);

/** A pty spawn that records the argv of every spawn, so a test can assert what flags claude was launched
 *  with. Returns a minimal IPty-shaped stub. */
function argCapturingSpawn() {
  const spawnedArgv: string[][] = [];
  const ptys: EventEmitter[] = [];
  const spawn = ((_file: string, args: string[]) => {
    if (Array.isArray(args)) spawnedArgv.push(args);
    const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
    ee.write = () => {};
    ee.resize = () => {};
    ee.kill = () => {};
    ee.onData = (cb: (data: string) => void) => void ee.on("data", cb);
    ee.onExit = (cb: (event: { exitCode: number }) => void) => void ee.on("exit", cb);
    ptys.push(ee);
    return ee;
  }) as never;
  return { spawn, spawnedArgv, ptys };
}

function fakePtyFactory() {
  const ptys: EventEmitter[] = [];
  const spawn = () => {
    const ee = new EventEmitter() as EventEmitter & {
      write(d: string): void;
      resize(c: number, r: number): void;
      resizes: Array<[number, number]>;
      kill(): void;
      onData(cb: (d: string) => void): void;
      onExit(cb: (e: { exitCode: number }) => void): void;
    };
    ee.write = () => {};
    ee.resizes = [];
    ee.resize = (c, r) => void ee.resizes.push([c, r]);
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
  const m = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => ++t,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  return { m, store, ptys };
}

test("create persists a terminal row; attach spawns pty and fans data", async () => {
  const { m, store, ptys } = mgr();
  const meta = m.createLegacyClaude({ id: "s1", cwd: "/w" });
  expect(meta.mode).toBe("terminal");
  expect(store.get("s1")?.mode).toBe("terminal");

  const seen: string[] = [];
  const sub = await m.attach("s1", { onData: (d) => seen.push(d) });
  expect(sub).toBeDefined();
  ptys[0]!.emit("data", "redraw");
  expect(seen).toEqual(["redraw"]);
});

test("create derives model + effort from the spawn args (source of truth, like dangerouslySkip)", () => {
  const { m } = mgr();
  const meta = m.createLegacyClaude({ id: "e1", cwd: "/w", claudeArgs: ["--model", "opus", "--effort", "max"] });
  expect(meta.model).toBe("opus");
  expect(meta.effort).toBe("max");
  // No flags → undefined (claude's own default), never a crash.
  const bare = m.createLegacyClaude({ id: "e2", cwd: "/w" });
  expect(bare.model).toBeUndefined();
  expect(bare.effort).toBeUndefined();
});

test("spawn flags survive a server restart: live adoption is command-free and a later respawn reuses them", async () => {
  // The ended-overlay Restart used to spawn a BARE claude after a server restart (rehydrate wiped claudeArgs
  // to []) — so danger/model/effort were silently dropped. Now the user flags are persisted + restored.
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, spawnedArgv, ptys } = argCapturingSpawn();
  const mk = () =>
    new TerminalManager({ store, providers: claudeRegistry(), now: () => 1, ptySpawn: spawn, runTmux: () => {} });

  mk().createLegacyClaude({
    id: "s1",
    cwd: "/w",
    claudeArgs: ["--model", "opus", "--effort", "max", "--dangerously-skip-permissions"],
  });

  // A fresh manager (the restarted server) rehydrates from the SAME store; the tmux session is still alive.
  const m2 = mk();
  m2.rehydrate({ liveTmuxNames: ["rc-s1"] });
  const meta = m2.get("s1")!;
  expect(meta.dangerouslySkip).toBe(true); // meta stays truthful after a restart …
  expect(meta.model).toBe("opus");
  expect(meta.effort).toBe("max");

  // A live rehydrate adopts the existing tmux pane without supplying a provider command (tmux already owns
  // the running Claude process, so re-running flags here would risk a duplicate conversation).
  await m2.attach("s1", { onData: () => {} });
  expect(spawnedArgv.at(-1)).toEqual(expect.arrayContaining(["attach-session", "-t", "rc-s1"]));
  expect(spawnedArgv.at(-1)).not.toContain("--model");

  // Once the adopted live process really exits, a subsequent fresh respawn regenerates the same persisted
  // provider flags instead of starting a bare Claude process.
  ptys[0]!.emit("exit", { exitCode: 0 });
  await m2.attach("s1", { onData: () => {} }, undefined, { respawn: "fresh" });
  const argv = (spawnedArgv.at(-1) ?? []).join(" ");
  expect(argv).toContain("--model opus");
  expect(argv).toContain("--effort max");
  expect(argv).toContain("--dangerously-skip-permissions");
});

test("a rehydrated session regenerates MCP + hooks only after the adopted live process exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-tm-"));
  try {
    const store = openSessionStore({ dbPath: ":memory:" });
    const { spawn, spawnedArgv, ptys } = argCapturingSpawn();
    const mk = () =>
      new TerminalManager({ store, providers: claudeRegistry(), now: () => 1, ptySpawn: spawn, runTmux: () => {} });
    mk().createLegacyClaude({ id: "s1", cwd: "/w", claudeArgs: ["--effort", "high"] });

    const m2 = mk();
    // attachConfig is only set AFTER boot rehydrate in prod. Adopting the still-live tmux process must not
    // rewrite configs or supply a provider command; after that process exits, the actual respawn regenerates.
    m2.setAttachConfig({ baseUrl: "http://127.0.0.1:1", token: "tok", mcpScriptPath: "/x/mcp-send.js", dataDir: dir });
    m2.rehydrate({ liveTmuxNames: ["rc-s1"] });
    await m2.attach("s1", { onData: () => {} });
    expect(spawnedArgv.at(-1)).toEqual(expect.arrayContaining(["attach-session", "-t", "rc-s1"]));
    expect(spawnedArgv.at(-1)).not.toContain("--mcp-config");

    ptys[0]!.emit("exit", { exitCode: 0 });
    await m2.attach("s1", { onData: () => {} }, undefined, { respawn: "fresh" });

    const argv = (spawnedArgv.at(-1) ?? []).join(" ");
    expect(argv).toContain("--effort high"); // the user flag survived …
    expect(argv).toContain("--mcp-config"); // … and the per-session configs were regenerated for the respawn
    expect(argv).toContain("--settings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup sweeping removes stale Codex MCP tokens while preserving live artifacts and unrelated files", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-stale-codex-token-"));
  const staleTokenPath = codexMcpTokenPathFor(dir, "stale-session");
  const liveTokenPath = codexMcpTokenPathFor(dir, "live-session");
  const unrelatedPath = join(dir, "deployment-notes.txt");
  const store = openSessionStore({ dbPath: ":memory:" });
  const m = new TerminalManager({
    store,
    providers: new ProviderRegistry([createCodexProvider({ codexBin: "codex", env: {} })]),
    now: () => 1,
    runTmux: () => {},
  });

  try {
    store.upsert({
      provider: "codex",
      id: "live-session",
      cwd: "/work",
      mode: "terminal",
      status: "running",
      createdAt: 1,
      lastActivityAt: 1,
      launchOptions: { provider: "codex" },
    });
    m.rehydrate({ liveTmuxNames: ["rc-live-session"] });
    expect(m.get("live-session")).toMatchObject({ provider: "codex", status: "running" });

    writeFileSync(staleTokenPath, "stale-bearer-token", { mode: 0o600 });
    writeFileSync(liveTokenPath, "live-bearer-token", { mode: 0o600 });
    writeFileSync(unrelatedPath, "keep", { mode: 0o600 });
    m.setAttachConfig({
      baseUrl: "http://127.0.0.1:1",
      token: "current-token",
      mcpScriptPath: "/x/mcp-send.js",
      dataDir: dir,
    });

    expect(m.sweepStaleMcpConfigs()).toBe(1);
    expect(existsSync(staleTokenPath)).toBe(false);
    expect(existsSync(liveTokenPath)).toBe(true);
    expect(existsSync(unrelatedPath)).toBe(true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehydrate marks stored terminal sessions whose tmux session is alive", () => {
  const { m, store } = mgr();
  store.upsert({
    provider: "claude",
    id: "old",
    cwd: "/w",
    mode: "terminal",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
  });
  m.rehydrate({ liveTmuxNames: ["rc-old"] });
  expect(m.get("old")?.status).toBe("running");
});

test("rehydrate skips one malformed legacy spawnArgs row and continues adopting valid sessions", () => {
  const { m, store } = mgr();
  store.upsert({
    provider: "claude",
    id: "malformed",
    cwd: "/bad",
    mode: "terminal",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
    spawnArgs: ["--model"],
  });
  store.upsert({
    provider: "claude",
    id: "valid",
    cwd: "/good",
    mode: "terminal",
    dangerouslySkip: false,
    status: "running",
    createdAt: 2,
    lastActivityAt: 2,
    spawnArgs: ["--model", "opus"],
  });

  expect(() => m.rehydrate({ liveTmuxNames: ["rc-malformed", "rc-valid"] })).not.toThrow();
  expect(m.get("malformed")).toBeUndefined();
  expect(store.get("malformed")).toBeDefined();
  expect(m.get("valid")).toMatchObject({ id: "valid", model: "opus" });
});

test("stop kills and removes", async () => {
  const { m } = mgr();
  m.createLegacyClaude({ id: "x", cwd: "/w" });
  await m.attach("x", { onData: () => {} });
  m.stop("x");
  expect(m.get("x")).toBeUndefined();
});

test("pushControl fans a JSON control message (attachment) to attached subscribers", async () => {
  const { m } = mgr();
  m.createLegacyClaude({ id: "c", cwd: "/w" });
  const control: string[] = [];
  await m.attach("c", { onData: () => {}, onControl: (msg) => control.push(msg) });
  expect(m.pushControl("c", { t: "attach", name: "shot.png", isImage: true })).toBe(true);
  expect(JSON.parse(control[0]!)).toEqual({ t: "attach", name: "shot.png", isImage: true });
  expect(m.pushControl("unknown-id", { t: "attach" })).toBe(false); // no such session
});

/** A manager wired with the away-from-desk + finished notifiers, on fake timers. */
function awaitMgr() {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const awaiting: string[] = [];
  const finished: string[] = [];
  let t = 0;
  const m = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => ++t,
    ptySpawn: spawn as never,
    runTmux: () => {},
    onAwaiting: (id) => awaiting.push(id),
    onFinished: (id) => finished.push(id),
  });
  return { m, ptys, awaiting, finished };
}

afterEach(() => {
  vi.useRealTimers();
});

test("awaiting STICKS across pty output (claude repainting the idle prompt); only input clears it", async () => {
  const { m, ptys } = awaitMgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  await m.attach("a", { onData: () => {} });
  m.setAwaiting("a", true); // e.g. the capture-pane monitor flagged a decision prompt
  expect(m.get("a")?.awaiting).toBe(true);
  ptys[0]!.emit("data", "cursor/spinner repaint while claude waits"); // MUST NOT clear it (the old bug)
  expect(m.get("a")?.awaiting).toBe(true);
  m.write("a", "y"); // user input (or the UserPromptSubmit hook) clears it
  expect(m.get("a")?.awaiting).toBe(false);
});

test("isAttached reflects whether a client is connected", async () => {
  const { m } = awaitMgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  expect(m.isAttached("a")).toBe(false);
  const sub = await m.attach("a", { onData: () => {} });
  expect(m.isAttached("a")).toBe(true);
  sub!.unsubscribe();
  expect(m.isAttached("a")).toBe(false);
  expect(m.isAttached("nope")).toBe(false);
});

test("reattach to a still-running session forces a tmux redraw (size wiggle) so a fresh xterm isn't blank", async () => {
  vi.useFakeTimers();
  const { m, ptys } = mgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  await m.attach("a", { onData: () => {} }, { cols: 80, rows: 24 }); // first client → spawns the pty (tmux draws naturally)
  const pty = ptys[0]! as EventEmitter & { resizes: Array<[number, number]> };
  const before = pty.resizes.length;
  await m.attach("a", { onData: () => {} }, { cols: 80, rows: 24 }); // SECOND client reattaches to the LIVE pty (the bug case)
  vi.advanceTimersByTime(300); // let the deferred wiggle fire
  const wiggle = pty.resizes.slice(before);
  expect(wiggle[0]).toEqual([80, 25]); // +1 row → SIGWINCH → tmux redraws the whole screen
  expect(wiggle[wiggle.length - 1]).toEqual([80, 24]); // ...then restored to the real viewport size
  vi.useRealTimers();
});

test("reattach to a still-running session flips the newcomer onto the ALT screen (\\x1b[?1049h) before the redraw", async () => {
  // tmux sent its alt-screen enter only to the FIRST pty consumer; without this synthetic handoff a fresh
  // xterm renders the redraw into its NORMAL buffer — phantom scrollbar + two-finger scroll stops paging
  // claude (it scrolls the junk local scrollback instead).
  const { m, ptys } = mgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  const first: string[] = [];
  await m.attach("a", { onData: (c) => first.push(c) }, { cols: 80, rows: 24 }); // first client spawns the pty
  expect(ptys.length).toBe(1);
  expect(first).toEqual([]); // no synthetic frames for the spawning client — tmux itself sends the real init
  const second: string[] = [];
  await m.attach("a", { onData: (c) => second.push(c) }, { cols: 80, rows: 24 }); // joins the LIVE pty
  expect(second[0]).toBe("\x1b[?1049h"); // alt-screen enter arrives before any redraw output
});

test("walk-away ping: detaching the last client WHILE awaiting fires onAwaiting (you left it waiting)", async () => {
  const { m, awaiting } = awaitMgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  const sub = await m.attach("a", { onData: () => {} });
  m.setAwaiting("a", true); // claude's Stop hook fired while you were watching
  expect(awaiting).toEqual([]); // someone is watching → no push, just the flag
  sub!.unsubscribe(); // walked away while it was waiting → now fire the away-from-desk ping
  expect(awaiting).toEqual(["a"]);
});

test("onFinished fires when claude exits, and an ended session is not awaiting", async () => {
  const { m, ptys, finished } = awaitMgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  await m.attach("a", { onData: () => {} });
  m.setAwaiting("a", true);
  expect(m.get("a")?.awaiting).toBe(true);
  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(finished).toEqual(["a"]);
  expect(m.get("a")?.awaiting).toBe(false);
  expect(m.get("a")?.status).toBe("ended");
});

test("onFinished reports wasAttached (true) — captured before the subs are torn down", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const calls: Array<{ id: string; wasAttached: boolean }> = [];
  const m = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
    onFinished: (id, wasAttached) => calls.push({ id, wasAttached }),
  });
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  await m.attach("a", { onData: () => {} }); // a client is watching → the pty spawns
  ptys[0]!.emit("exit", { exitCode: 0 });
  // The transport gates the away-from-desk "finished" push on !wasAttached (an attached client already sees
  // the WS close); here a client was attached at exit, so wasAttached is reported true.
  expect(calls).toEqual([{ id: "a", wasAttached: true }]);
});

test("awaitingCount counts only the sessions currently awaiting you (drives the push badge)", () => {
  const { m } = mgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  m.createLegacyClaude({ id: "b", cwd: "/w" });
  m.createLegacyClaude({ id: "c", cwd: "/w" });
  expect(m.awaitingCount()).toBe(0);
  m.setAwaiting("a", true);
  m.setAwaiting("c", true);
  expect(m.awaitingCount()).toBe(2);
  m.setAwaiting("a", false);
  expect(m.awaitingCount()).toBe(1);
});

test("refreshActivity derives working/blocked/idle from the pane; awaiting = blocked only + fires the away push", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn } = fakePtyFactory();
  const pushed: string[] = [];
  let t = 0;
  // A fake pane per session (keyed by the tmux name rc-<id>), covering all three states.
  const panes: Record<string, string> = {
    "rc-work": "✻ Schlepping… (1m 17s · ↓ 2.1k tokens)\n❯\n  ⏵⏵ bypass permissions on · esc to interrupt",
    // main loop idle at the prompt, but a background agent is still developing → WORKING, not idle/needs-you
    "rc-agent": "❯\n  ⏵⏵ bypass permissions on\n  ⏺ general-purpose  Listing f… 24m 23s · ↓ 216.5k tokens",
    "rc-block": "  Do you want to proceed?\n❯ 1. Yes\n  2. No",
    "rc-idle": "✻ Baked for 3m 10s\n❯\n  ⏵⏵ bypass permissions on",
  };
  const m = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => ++t,
    ptySpawn: spawn as never,
    runTmux: () => {},
    onAwaiting: (id) => pushed.push(id),
    capturePane: (name) => Promise.resolve(panes[name] ?? ""),
  });
  for (const id of ["work", "agent", "block", "idle"]) m.createLegacyClaude({ id, cwd: "/w" });

  await m.refreshActivity();

  expect(m.get("work")?.activity).toBe("working");
  expect(m.get("agent")?.activity).toBe("working");
  expect(m.get("block")?.activity).toBe("blocked");
  expect(m.get("idle")?.activity).toBe("idle");
  // The loud "needs you" flag tracks BLOCKED only — a working or idle session is never awaiting.
  expect(m.get("work")?.awaiting).toBe(false);
  expect(m.get("block")?.awaiting).toBe(true);
  expect(m.get("idle")?.awaiting).toBe(false);
  // Nobody attached → the newly-blocked session fired the away push exactly once (working/idle don't).
  expect(pushed).toEqual(["block"]);
});

test("create derives dangerouslySkip from the spawn args and persists it", () => {
  const { m, store } = mgr();
  const skip = m.createLegacyClaude({ id: "sk", cwd: "/w", claudeArgs: ["--dangerously-skip-permissions"] });
  expect(skip.dangerouslySkip).toBe(true);
  expect(store.get("sk")?.dangerouslySkip).toBe(true);
  const safe = m.createLegacyClaude({ id: "safe", cwd: "/w", claudeArgs: ["--model", "opus"] });
  expect(safe.dangerouslySkip).toBe(false);
  expect(store.get("safe")?.dangerouslySkip).toBe(false);
});

test("rehydrate preserves the persisted dangerouslySkip flag", () => {
  const { m, store } = mgr();
  store.upsert({
    provider: "claude",
    id: "old",
    cwd: "/w",
    mode: "terminal",
    dangerouslySkip: true,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
  });
  m.rehydrate({ liveTmuxNames: ["rc-old"] });
  expect(m.get("old")?.dangerouslySkip).toBe(true);
});

test("setAwaiting explicitly toggles the flag (used by the ask flow)", () => {
  const { m } = mgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  m.setAwaiting("a", true);
  expect(m.get("a")?.awaiting).toBe(true);
  m.setAwaiting("a", false);
  expect(m.get("a")?.awaiting).toBe(false);
  expect(() => m.setAwaiting("nope", true)).not.toThrow(); // unknown id is a no-op
});

test("attachment frames are buffered and replayed to a client that connects later", async () => {
  const { m } = mgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  // A file arrives while nobody is attached — pushControl reaches no live client, but it's buffered.
  expect(m.pushControl("a", { t: "attach", id: "f1", name: "a.png", isImage: true })).toBe(true);
  expect(m.pushControl("a", { t: "attach", id: "f2", name: "b.txt", isImage: false })).toBe(true);

  // A client (re)connects → it receives the buffered attachments so its Files panel is correct.
  const replayed: unknown[] = [];
  await m.attach("a", { onData: () => {}, onControl: (json) => replayed.push(JSON.parse(json)) });
  expect(replayed).toEqual([
    { t: "attach", id: "f1", name: "a.png", isImage: true },
    { t: "attach", id: "f2", name: "b.txt", isImage: false },
  ]);
});

test("non-attach control frames are NOT buffered for replay", async () => {
  const { m } = mgr();
  m.createLegacyClaude({ id: "a", cwd: "/w" });
  m.pushControl("a", { t: "note", detail: "not an attachment" });
  const replayed: unknown[] = [];
  await m.attach("a", { onData: () => {}, onControl: (json) => replayed.push(JSON.parse(json)) });
  expect(replayed).toEqual([]); // only `attach` frames are buffered for replay; other frames are live-only
});

test("respawn=continue: only an ENDED session's respawn gets --continue, exactly once, without persisting it", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const spawnArgs: string[][] = [];
  const ptys: EventEmitter[] = [];
  const spawn = (_file: string, args: string[]) => {
    spawnArgs.push(args);
    const ee = new EventEmitter() as EventEmitter & {
      write(d: string): void;
      resize(c: number, r: number): void;
      kill(): void;
      onData(cb: (d: string) => void): void;
      onExit(cb: (e: { exitCode: number }) => void): void;
    };
    ee.write = () => {};
    ee.resize = () => {};
    ee.kill = () => {};
    ee.onData = (cb) => void ee.on("data", cb);
    ee.onExit = (cb) => void ee.on("exit", cb);
    ptys.push(ee);
    return ee;
  };
  const m = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  m.createLegacyClaude({ id: "r", cwd: "/w", claudeArgs: ["--model", "opus"] });

  // FIRST spawn of a RUNNING session: respawn=continue must be IGNORED (nothing to resume).
  await m.attach("r", { onData: () => {} }, undefined, { respawn: "continue" });
  expect(spawnArgs[0]!.filter((a) => a === "--continue")).toHaveLength(0);

  // claude exits → the session is ENDED; a respawn=continue reattach appends --continue EXACTLY ONCE.
  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(m.get("r")?.status).toBe("ended");
  await m.attach("r", { onData: () => {} }, undefined, { respawn: "continue" });
  expect(spawnArgs[1]!.filter((a) => a === "--continue")).toHaveLength(1);
  // --continue is appended AFTER the stored args (claude reads the last occurrence of a repeated flag).
  expect(spawnArgs[1]!.indexOf("--continue")).toBeGreaterThan(spawnArgs[1]!.indexOf("--model"));

  // The STORED args were not mutated: a later PLAIN respawn spawns without --continue (and still
  // carries the original args).
  ptys[1]!.emit("exit", { exitCode: 0 });
  await m.attach("r", { onData: () => {} });
  expect(spawnArgs[2]!.filter((a) => a === "--continue")).toHaveLength(0);
  expect(spawnArgs[2]!).toContain("--model");

  // And an explicit respawn=fresh behaves like today's default.
  ptys[2]!.emit("exit", { exitCode: 0 });
  await m.attach("r", { onData: () => {} }, undefined, { respawn: "fresh" });
  expect(spawnArgs[3]!.filter((a) => a === "--continue")).toHaveLength(0);
});

test("detaching the last subscriber stops the pty without killing the tmux session", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn } = fakePtyFactory();
  const tmuxCalls: string[][] = [];
  const m = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: (a) => tmuxCalls.push(a),
  });
  m.createLegacyClaude({ id: "d1", cwd: "/w" });
  const sub = await m.attach("d1", { onData: () => {} });
  sub!.unsubscribe();
  // detach must NOT kill the tmux session — tmux persists so a reconnect can re-attach
  expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  expect(m.get("d1")).toBeDefined();
});

function recordingProvider(
  id: ProviderId,
  spec: ProcessSpec,
  signals: (chunk: string) => ProviderRuntimeSignal[] = () => [],
) {
  const buildCalls: ProviderProcessContext[] = [];
  const cleanupCalls: string[][] = [];
  let buildGate: Promise<void> | undefined;
  let releaseBuild: (() => void) | undefined;
  const provider: AgentProvider = {
    id,
    displayName: id,
    resumeIdentity: id === "codex" ? "required" : "optional",
    probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
    buildProcess: async (context) => {
      buildCalls.push(context);
      if (buildGate) await buildGate;
      return spec;
    },
    runtimeSignals: signals,
    classifyPane: () => "idle",
    cleanup: (paths) => cleanupCalls.push([...paths]),
  };
  return {
    provider,
    buildCalls,
    cleanupCalls,
    pauseBuild: () => {
      buildGate = new Promise<void>((resolve) => (releaseBuild = resolve));
    },
    resumeBuild: () => {
      releaseBuild?.();
      buildGate = undefined;
      releaseBuild = undefined;
    },
  };
}

test("spawns the executable returned by the owning provider", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, spawnedArgv } = argCapturingSpawn();
  const fake = recordingProvider("codex", {
    executable: "/bin/codex",
    args: ["--model", "gpt"],
    env: { SAFE: "yes" },
    cleanupPaths: [],
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn,
    runTmux: () => {},
  });

  manager.create({ id: "x", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("x", { onData: () => {} });

  expect(spawnedArgv.at(-1)).toContain("/bin/codex");
  expect(fake.buildCalls).toMatchObject([{ roamSessionId: "x", intent: "fresh", options: { provider: "codex" } }]);
});

test("uses an injected tmux socket for fresh spawn, exact resume, and kill", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, spawnedArgv } = argCapturingSpawn();
  const { ptys, spawn: eventSpawn } = fakePtyFactory();
  const tmuxCalls: string[][] = [];
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] }, (chunk) =>
    chunk === "identity" ? [{ type: "provider-session-id", id: "thread-socket" }] : [],
  );
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    tmuxSocket: "rc-providers-itg-test",
    ptySpawn: ((file, args, opts) => {
      spawn(file, args, opts);
      return eventSpawn();
    }) as never,
    runTmux: (args) => tmuxCalls.push(args),
  });

  manager.create({ id: "socket", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("socket", { onData: () => {} });
  expect(spawnedArgv[0]?.slice(0, 2)).toEqual(["-L", "rc-providers-itg-test"]);

  ptys[0]!.emit("data", "identity");
  ptys[0]!.emit("exit", { exitCode: 0 });
  await manager.attach("socket", { onData: () => {} }, undefined, { respawn: "continue" });
  expect(spawnedArgv[1]?.slice(0, 2)).toEqual(["-L", "rc-providers-itg-test"]);

  manager.stop("socket");
  expect(tmuxCalls.at(-1)?.slice(0, 2)).toEqual(["-L", "rc-providers-itg-test"]);
});

test("the Claude adapter owns subscription env stripping without putting secrets in argv", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  let spawnedArgs: string[] = [];
  const { spawn } = fakePtyFactory();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([
      createClaudeProvider({
        claudeBin: "/bin/claude",
        env: { ANTHROPIC_API_KEY: "must-not-leak", SAFE: "yes" },
      }),
    ]),
    now: () => 1,
    ptySpawn: ((file, args, opts) => {
      spawnedArgs = args;
      spawnedEnv = opts.env;
      return spawn(file, args, opts);
    }) as never,
    runTmux: () => {},
  });
  manager.createLegacyClaude({ id: "c", cwd: "/w" });
  await manager.attach("c", { onData: () => {} });

  expect(spawnedEnv).toMatchObject({ SAFE: "yes" });
  expect(spawnedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
  expect(spawnedArgs.join(" ")).not.toContain("must-not-leak");
  expect(store.get("c")).not.toHaveProperty("ANTHROPIC_API_KEY");
});

test("resume delegates to the provider with the persisted exact id", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] }, (chunk) =>
    chunk === "identity" ? [{ type: "provider-session-id", id: "thread-123" }] : [],
  );
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "x", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("x", { onData: () => {} });
  ptys[0]!.emit("data", "identity");
  ptys[0]!.emit("exit", { exitCode: 0 });

  await manager.attach("x", { onData: () => {} }, undefined, { respawn: "continue" });

  expect(fake.buildCalls.at(-1)).toMatchObject({
    roamSessionId: "x",
    intent: "resume",
    providerSessionId: "thread-123",
  });
  expect(store.get("x")).toMatchObject({ provider: "codex", providerSessionId: "thread-123" });
});

test("resume fails closed when the owning provider has no exact identity", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "x", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("x", { onData: () => {} });
  ptys[0]!.emit("exit", { exitCode: 0 });

  await expect(manager.attach("x", { onData: () => {} }, undefined, { respawn: "continue" })).rejects.toMatchObject({
    code: "RESUME_IDENTITY_UNAVAILABLE",
  } satisfies Partial<ProviderError>);
  expect(fake.buildCalls).toHaveLength(1);
});

test("concurrent async attaches share one provider build and one PTY spawn", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
  fake.pauseBuild();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "x", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  const first = manager.attach("x", { onData: () => {} });
  const second = manager.attach("x", { onData: () => {} });
  await Promise.resolve();
  expect(fake.buildCalls).toHaveLength(1);
  fake.resumeBuild();
  await Promise.all([first, second]);

  expect(ptys).toHaveLength(1);
});

test("provider runtime signals update activity and conflicting identities disable resume", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider(
    "codex",
    { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] },
    (chunk) => {
      if (chunk === "blocked") return [{ type: "blocked" }];
      if (chunk === "idle") return [{ type: "idle" }];
      if (chunk === "one") return [{ type: "provider-session-id", id: "thread-1" }];
      if (chunk === "two") return [{ type: "provider-session-id", id: "thread-2" }];
      return [];
    },
  );
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "x", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("x", { onData: () => {} });

  ptys[0]!.emit("data", "blocked");
  expect(manager.get("x")).toMatchObject({ activity: "blocked", awaiting: true });
  ptys[0]!.emit("data", "idle");
  expect(manager.get("x")).toMatchObject({ activity: "idle", awaiting: false });
  ptys[0]!.emit("data", "one");
  ptys[0]!.emit("data", "two");
  expect(store.get("x")?.providerSessionId).toBeUndefined();
  ptys[0]!.emit("exit", { exitCode: 0 });
  await expect(manager.attach("x", { onData: () => {} }, undefined, { respawn: "continue" })).rejects.toMatchObject({
    code: "RESUME_IDENTITY_UNAVAILABLE",
  });
});

test("Codex split-frame activity parsing is isolated per concurrent terminal process", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const provider = createCodexProvider({
    codexBin: "/bin/codex",
    env: {},
    attach: {
      baseUrl: "http://127.0.0.1:4280",
      token: "manager-secret-token",
      mcpScriptPath: "/opt/roamcode/mcp-send.js",
      dataDir: "/unused-for-codex",
    },
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "one", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  manager.create({ id: "two", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  const firstOutput: string[] = [];
  await manager.attach("one", { onData: (chunk) => firstOutput.push(chunk) });
  await manager.attach("two", { onData: () => {} });

  ptys[0]!.emit("data", "\u001bPtmux;\u001b\u001b]9;Approval req");
  ptys[1]!.emit("data", "uested: git status\u0007\u001b\\");
  expect(manager.get("one")?.activity).toBe("idle");
  expect(manager.get("two")?.activity).toBe("idle");

  ptys[0]!.emit("data", "uested: git status\u0007\u001b\\");
  expect(manager.get("one")).toMatchObject({ activity: "blocked", awaiting: true });
  expect(manager.get("two")).toMatchObject({ activity: "idle", awaiting: false });
  expect(firstOutput).toEqual(["\u001bPtmux;\u001b\u001b]9;Approval req", "uested: git status\u0007\u001b\\"]);
  expect(JSON.stringify(store.list())).not.toContain("manager-secret-token");
});

test("provider cleanup runs exactly once on explicit stop and spawn failure", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn } = fakePtyFactory();
  const fake = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/provider-artifact"],
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "ok", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("ok", { onData: () => {} });
  manager.stop("ok");
  expect(fake.cleanupCalls).toEqual([["/tmp/provider-artifact"]]);

  const throwingManager = new TerminalManager({
    store: openSessionStore({ dbPath: ":memory:" }),
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: (() => {
      throw new Error("spawn failed");
    }) as never,
    runTmux: () => {},
  });
  throwingManager.create({ id: "bad", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await expect(throwingManager.attach("bad", { onData: () => {} })).rejects.toThrow("spawn failed");
  expect(fake.cleanupCalls).toEqual([["/tmp/provider-artifact"], ["/tmp/provider-artifact"]]);
});

test("awaits the pre-spawn proof after the live-record check and immediately before construction", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const events: string[] = [];
  const cleanupCalls: string[][] = [];
  const provider: AgentProvider = {
    id: "codex",
    displayName: "Codex",
    resumeIdentity: "required",
    probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
    buildProcess: async () => ({
      executable: "/bin/codex",
      args: [],
      env: {},
      cleanupPaths: ["/tmp/pre-spawn-proof"],
      preSpawnCheck: async () => {
        events.push("proof:start");
        await Promise.resolve();
        events.push("proof:failure");
        throw new Error("profile changed");
      },
    }),
    runtimeSignals: () => [],
    classifyPane: () => "idle",
    cleanup: (paths) => cleanupCalls.push([...paths]),
  };
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider]),
    now: () => 1,
    ptySpawn: (() => {
      events.push("construct");
      return fakePtyFactory().spawn();
    }) as never,
    runTmux: () => {},
  });
  manager.create({ id: "proof", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  await expect(manager.attach("proof", { onData: () => {} })).rejects.toThrow("profile changed");

  expect(events).toEqual(["proof:start", "proof:failure"]);
  expect(cleanupCalls).toEqual([["/tmp/pre-spawn-proof"]]);
  expect(manager.get("proof")).toMatchObject({ status: "ended" });
  expect(store.get("proof")).toMatchObject({ provider: "codex" });
  manager.stop("proof");
  expect(cleanupCalls).toEqual([["/tmp/pre-spawn-proof"]]);
});

test("rechecks record liveness after an async pre-spawn proof before constructing the process", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const events: string[] = [];
  let finishProof!: () => void;
  const proofGate = new Promise<void>((resolve) => {
    finishProof = resolve;
  });
  const provider: AgentProvider = {
    id: "codex",
    displayName: "Codex",
    resumeIdentity: "required",
    probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
    buildProcess: async () => ({
      executable: "/bin/codex",
      args: [],
      env: {},
      cleanupPaths: ["/tmp/pre-spawn-race"],
      preSpawnCheck: async () => {
        events.push("proof");
        await proofGate;
      },
    }),
    runtimeSignals: () => [],
    classifyPane: () => "idle",
    cleanup: () => void events.push("cleanup"),
  };
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider]),
    now: () => 1,
    ptySpawn: (() => {
      events.push("construct");
      return fakePtyFactory().spawn();
    }) as never,
    runTmux: () => {},
  });
  manager.create({ id: "proof-race", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  const attaching = manager.attach("proof-race", { onData: () => {} });
  await vi.waitFor(() => expect(events).toEqual(["proof"]));
  manager.stop("proof-race");
  finishProof();

  await expect(attaching).resolves.toBeUndefined();
  expect(events).toEqual(["proof", "cleanup"]);
  expect(manager.get("proof-race")).toBeUndefined();
  expect(store.get("proof-race")).toBeUndefined();
});

test("runs a synchronous pre-spawn proof immediately before process construction", async () => {
  const events: string[] = [];
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: [],
    preSpawnCheck: () => void events.push("proof"),
  });
  const manager = new TerminalManager({
    store: openSessionStore({ dbPath: ":memory:" }),
    providers: new ProviderRegistry([provider.provider]),
    now: () => 1,
    ptySpawn: (() => {
      events.push("construct");
      return fakePtyFactory().spawn();
    }) as never,
    runTmux: () => {},
  });
  manager.create({ id: "sync-proof", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  await manager.attach("sync-proof", { onData: () => {} });

  expect(events).toEqual(["proof", "construct"]);
});

test("runs the selected-profile proof inside discovery immediately before the real Codex spawn", async () => {
  const events: string[] = [];
  let inventoryRead = 0;
  const store = openSessionStore({ dbPath: ":memory:" });
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: [],
    preSpawnCheck: async () => void events.push("proof"),
  });
  const resolver = new CodexThreadResolver({
    now: () => 10_000,
    inventory: async () => {
      inventoryRead += 1;
      events.push(
        inventoryRead === 1 ? "inventory-before" : inventoryRead === 2 ? "inventory-poll" : "inventory-crosscheck",
      );
      return inventoryRead === 1 ? [] : [{ id: "thread-proof", cwd: "/w", source: "cli" as const, createdAt: 10 }];
    },
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolver,
    now: () => 10_000,
    ptySpawn: (() => {
      events.push("construct");
      return fakePtyFactory().spawn();
    }) as never,
    runTmux: () => {},
  });
  manager.create({ id: "profile-proof", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  await manager.attach("profile-proof", { onData: () => {} });

  expect(events).toEqual(["inventory-before", "proof", "construct", "inventory-poll", "inventory-crosscheck"]);
  expect(manager.get("profile-proof")).toMatchObject({
    identityState: "exact",
    providerSessionId: "thread-proof",
  });
});

test("resolver-enabled PTY spawn failure rejects attach and leaves no broken running process", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/resolver-spawn-failure"],
  });
  let inventoryRead = 0;
  const resolver = new CodexThreadResolver({
    inventory: async () => {
      inventoryRead += 1;
      return [];
    },
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolver,
    now: () => 1,
    ptySpawn: (() => {
      throw new Error("pty spawn failed with secret argv");
    }) as never,
    runTmux: () => {},
  });
  manager.create({ id: "spawn-failure", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  await expect(manager.attach("spawn-failure", { onData: () => {} })).rejects.toThrow("pty spawn failed");

  expect(manager.get("spawn-failure")).toMatchObject({ status: "ended" });
  expect(store.get("spawn-failure")).toMatchObject({ status: "errored" });
  expect(provider.cleanupCalls).toEqual([["/tmp/resolver-spawn-failure"]]);
  expect(inventoryRead).toBe(1);
});

test("resolver deadline before PTY spawn re-proves and starts one explicitly ambiguous fallback", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  let proofCalls = 0;
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: [],
    preSpawnCheck: async () => {
      proofCalls += 1;
      if (proofCalls === 1) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    },
  });
  const resolver = new CodexThreadResolver({
    inventory: async () => [],
    deadlineMs: 5,
    pollIntervalMs: 1,
    cancellationAckMs: 100,
  });
  const { spawn, ptys } = fakePtyFactory();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolver,
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "deadline-fallback", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  try {
    await expect(manager.attach("deadline-fallback", { onData: () => {} })).resolves.toBeDefined();
    expect(ptys).toHaveLength(1);
    expect(proofCalls).toBe(2);
    expect(manager.get("deadline-fallback")).toMatchObject({ status: "running", identityState: "ambiguous" });
  } finally {
    resetCodexThreadResolutionCoordinatorForTests();
  }
});

test("detach during resolver pre-spawn proof leaves an ended clean record instead of running", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  let beginProof!: () => void;
  let releaseProof!: () => void;
  const proofStarted = new Promise<void>((resolve) => (beginProof = resolve));
  const proofGate = new Promise<void>((resolve) => (releaseProof = resolve));
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/detached-before-spawn"],
    preSpawnCheck: async () => {
      beginProof();
      await proofGate;
    },
  });
  const resolver = new CodexThreadResolver({ inventory: async () => [] });
  const { spawn, ptys } = fakePtyFactory();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolver,
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "detached-proof", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  const controller = new AbortController();
  const attaching = manager.attach("detached-proof", { onData: () => {} }, undefined, {
    signal: controller.signal,
  });
  await proofStarted;

  controller.abort();
  releaseProof();

  await expect(attaching).resolves.toBeUndefined();
  expect(ptys).toHaveLength(0);
  expect(manager.get("detached-proof")).toMatchObject({ status: "ended", identityState: "ambiguous" });
  expect(store.get("detached-proof")).toMatchObject({ status: "dormant" });
  expect(provider.cleanupCalls).toEqual([["/tmp/detached-before-spawn"]]);
});

test("detach during degraded fallback re-proof also leaves an ended clean record", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  let beginProof!: () => void;
  let releaseProof!: () => void;
  const proofStarted = new Promise<void>((resolve) => (beginProof = resolve));
  const proofGate = new Promise<void>((resolve) => (releaseProof = resolve));
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/detached-fallback-proof"],
    preSpawnCheck: async () => {
      beginProof();
      await proofGate;
    },
  });
  const resolver = new CodexThreadResolver({
    inventory: async () => {
      throw new Error("metadata unavailable before lease");
    },
  });
  const { spawn, ptys } = fakePtyFactory();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolver,
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "detached-fallback", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  const controller = new AbortController();
  const attaching = manager.attach("detached-fallback", { onData: () => {} }, undefined, {
    signal: controller.signal,
  });

  try {
    await proofStarted;
    controller.abort();
    releaseProof();

    await expect(attaching).resolves.toBeUndefined();
    expect(ptys).toHaveLength(0);
    expect(manager.get("detached-fallback")).toMatchObject({ status: "ended", identityState: "ambiguous" });
    expect(store.get("detached-fallback")).toMatchObject({ status: "dormant" });
    expect(provider.cleanupCalls).toEqual([["/tmp/detached-fallback-proof"]]);
  } finally {
    resetCodexThreadResolutionCoordinatorForTests();
  }
});

test("fresh respawn retires an old exact Codex identity before discovery and commits the new exact id", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: [],
  });
  const thread = (id: string, createdAt: number) => ({ id, cwd: "/w", source: "cli" as const, createdAt });
  const resolverFor = (now: number, before: ReturnType<typeof thread>[], after: ReturnType<typeof thread>[]) => {
    let read = 0;
    return new CodexThreadResolver({
      now: () => now,
      cancellationAckMs: 10,
      inventory: async () => {
        read += 1;
        return read === 1 ? before : after;
      },
    });
  };
  const resolvers = [
    resolverFor(10_000, [], [thread("thread-old", 10)]),
    resolverFor(20_000, [thread("thread-old", 10)], [thread("thread-old", 10), thread("thread-new", 20)]),
    resolverFor(
      30_000,
      [thread("thread-old", 10), thread("thread-new", 20)],
      [thread("thread-old", 10), thread("thread-new", 20), thread("thread-later", 30)],
    ),
  ];
  let resolverIndex = 0;
  const { spawn, ptys } = fakePtyFactory();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolvers[resolverIndex++]!,
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });

  try {
    manager.create({ id: "fresh-restart", cwd: "/w", provider: "codex", options: { provider: "codex" } });
    await manager.attach("fresh-restart", { onData: () => {} });
    expect(manager.get("fresh-restart")).toMatchObject({
      identityState: "exact",
      providerSessionId: "thread-old",
    });
    ptys[0]!.emit("exit", { exitCode: 0 });

    await manager.attach("fresh-restart", { onData: () => {} }, undefined, { respawn: "fresh" });
    expect(provider.buildCalls[1]).toMatchObject({ intent: "fresh" });
    expect(provider.buildCalls[1]).not.toHaveProperty("providerSessionId");
    expect(manager.get("fresh-restart")).toMatchObject({
      status: "running",
      identityState: "exact",
      providerSessionId: "thread-new",
    });
    expect(store.get("fresh-restart")).toMatchObject({ providerSessionId: "thread-new" });

    manager.create({ id: "later", cwd: "/w", provider: "codex", options: { provider: "codex" } });
    await manager.attach("later", { onData: () => {} });
    expect(manager.get("later")).toMatchObject({ identityState: "exact", providerSessionId: "thread-later" });
  } finally {
    resetCodexThreadResolutionCoordinatorForTests();
  }
});

test("fresh respawn fails closed when retiring the old authoritative identity cannot persist", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const provider = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: [],
  });
  const thread = (id: string, createdAt: number) => ({ id, cwd: "/w", source: "cli" as const, createdAt });
  const resolverFor = (now: number, before: ReturnType<typeof thread>[], after: ReturnType<typeof thread>[]) => {
    let read = 0;
    return new CodexThreadResolver({
      now: () => now,
      inventory: async () => (++read === 1 ? before : after),
    });
  };
  const resolvers = [
    resolverFor(10_000, [], [thread("thread-authoritative", 10)]),
    resolverFor(
      20_000,
      [thread("thread-authoritative", 10)],
      [thread("thread-authoritative", 10), thread("thread-independent", 20)],
    ),
  ];
  let resolverIndex = 0;
  const { spawn, ptys } = fakePtyFactory();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider.provider]),
    codexThreadResolver: () => resolvers[resolverIndex++]!,
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "retire-failure", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("retire-failure", { onData: () => {} });
  ptys[0]!.emit("exit", { exitCode: 0 });

  const setProviderSessionId = store.setProviderSessionId.bind(store);
  store.setProviderSessionId = (id, value) => {
    if (id === "retire-failure" && value === undefined) throw new Error("retirement storage failed");
    setProviderSessionId(id, value);
  };
  await expect(manager.attach("retire-failure", { onData: () => {} }, undefined, { respawn: "fresh" })).rejects.toThrow(
    "retirement storage failed",
  );
  expect(ptys).toHaveLength(1);
  expect(manager.get("retire-failure")).toMatchObject({
    status: "ended",
    identityState: "exact",
    providerSessionId: "thread-authoritative",
  });
  expect(store.get("retire-failure")).toMatchObject({ providerSessionId: "thread-authoritative" });

  store.setProviderSessionId = setProviderSessionId;
  manager.create({ id: "independent", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("independent", { onData: () => {} });
  expect(manager.get("independent")).toMatchObject({
    identityState: "exact",
    providerSessionId: "thread-independent",
  });
});

test("fresh Codex intent retires the old exact id even when no metadata resolver is configured", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const provider: AgentProvider = {
    id: "codex",
    displayName: "Codex",
    resumeIdentity: "required",
    probe: async () => ({ terminalAvailable: true, metadataAvailable: false }),
    buildProcess: async () => ({ executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] }),
    runtimeSignals: (chunk) =>
      chunk === "old-id" ? [{ type: "provider-session-id", id: "thread-without-resolver" }] : [],
    classifyPane: () => "idle",
    cleanup: () => {},
  };
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "fresh-no-resolver", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("fresh-no-resolver", { onData: () => {} });
  ptys[0]!.emit("data", "old-id");
  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(store.get("fresh-no-resolver")).toMatchObject({ providerSessionId: "thread-without-resolver" });

  await manager.attach("fresh-no-resolver", { onData: () => {} }, undefined, { respawn: "fresh" });

  expect(manager.get("fresh-no-resolver")).toMatchObject({
    status: "running",
    identityState: "pending",
    providerSessionId: undefined,
  });
  expect(store.get("fresh-no-resolver")?.providerSessionId).toBeUndefined();
});

test("provider cleanup runs exactly once when build rejects after registering a token-bearing artifact", async () => {
  const cleanupCalls: string[][] = [];
  const provider: AgentProvider = {
    id: "codex",
    displayName: "Codex",
    resumeIdentity: "required",
    probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
    buildProcess: async (context) => {
      const withCleanupRegistration = context as typeof context & {
        registerCleanupPaths?: (paths: readonly string[]) => void;
      };
      withCleanupRegistration.registerCleanupPaths?.(["/tmp/build-failed-token-bearing"]);
      throw new Error("build failed");
    },
    runtimeSignals: () => [],
    classifyPane: () => "idle",
    cleanup: (paths) => cleanupCalls.push([...paths]),
  };
  const manager = new TerminalManager({
    store: openSessionStore({ dbPath: ":memory:" }),
    providers: new ProviderRegistry([provider]),
    now: () => 1,
    runTmux: () => {},
  });
  manager.create({ id: "build-failure", cwd: "/w", provider: "codex", options: { provider: "codex" } });

  await expect(manager.attach("build-failure", { onData: () => {} })).rejects.toThrow("build failed");
  expect(cleanupCalls).toEqual([["/tmp/build-failed-token-bearing"]]);
});

test("partial legacy hook build removes the already-written token file immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-partial-hook-"));
  try {
    const configPath = hooksSettingsPathFor(dir, "partial");
    const authPath = hookAuthPathFor(dir, "partial");
    mkdirSync(configPath);
    const manager = new TerminalManager({
      store: openSessionStore({ dbPath: ":memory:" }),
      providers: claudeRegistry(),
      now: () => 1,
      ptySpawn: fakePtyFactory().spawn as never,
      runTmux: () => {},
    });
    manager.setAttachConfig({
      baseUrl: "http://127.0.0.1:1",
      token: "must-not-remain-on-disk",
      mcpScriptPath: "/x/mcp-send.js",
      dataDir: dir,
    });
    manager.createLegacyClaude({ id: "partial", cwd: "/w" });

    await manager.attach("partial", { onData: () => {} });

    expect(existsSync(authPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider cleanup removes token-bearing artifacts exactly once on natural exit", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/hook-auth-token-bearing"],
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "natural", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("natural", { onData: () => {} });

  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(fake.cleanupCalls).toEqual([["/tmp/hook-auth-token-bearing"]]);
  manager.stop("natural");

  expect(fake.cleanupCalls).toEqual([["/tmp/hook-auth-token-bearing"]]);
});

test("detached natural exit remains observable and removes token-bearing artifacts exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-detached-cleanup-"));
  const artifact = join(dir, "provider-token");
  try {
    const store = openSessionStore({ dbPath: ":memory:" });
    const { spawn, ptys } = fakePtyFactory();
    const cleanupCalls: string[][] = [];
    const provider: AgentProvider = {
      id: "codex",
      displayName: "Codex",
      resumeIdentity: "required",
      probe: () => Promise.resolve({ terminalAvailable: true, metadataAvailable: true }),
      buildProcess: async (context) => {
        writeFileSync(artifact, "token-bearing-secret", { mode: 0o600 });
        context.registerCleanupPaths?.([artifact]);
        return { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [artifact] };
      },
      runtimeSignals: (chunk) => (chunk === "identity" ? [{ type: "provider-session-id", id: "thread-detached" }] : []),
      classifyPane: () => "idle",
      cleanup: (paths) => {
        cleanupCalls.push([...paths]);
        for (const path of paths) rmSync(path, { recursive: true, force: true });
      },
    };
    const manager = new TerminalManager({
      store,
      providers: new ProviderRegistry([provider]),
      now: () => 1,
      ptySpawn: spawn as never,
      runTmux: () => {},
    });
    manager.create({ id: "detached", cwd: "/w", provider: "codex", options: { provider: "codex" } });
    const sub = await manager.attach("detached", { onData: () => {} });
    ptys[0]!.emit("data", "identity");

    sub!.unsubscribe();
    ptys[0]!.emit("exit", { exitCode: 0 });

    expect(manager.get("detached")).toMatchObject({ status: "ended", activity: "idle", awaiting: false });
    expect(store.get("detached")).toMatchObject({ providerSessionId: "thread-detached" });
    expect(cleanupCalls).toEqual([[artifact]]);
    expect(existsSync(artifact)).toBe(false);
    manager.stop("detached");
    expect(cleanupCalls).toEqual([[artifact]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reattach after last-subscriber detach reuses the live process with replay and resize intact", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "reattach", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  const first = await manager.attach("reattach", { onData: () => {} });
  manager.pushControl("reattach", { t: "attach", id: "file-1", name: "proof.txt" });
  first!.unsubscribe();

  const replayed: string[] = [];
  await manager.attach("reattach", { onData: () => {}, onControl: (message) => replayed.push(message) });
  manager.resize("reattach", 111, 37);

  expect(fake.buildCalls).toHaveLength(1);
  expect(ptys).toHaveLength(1);
  expect(replayed.map((message) => JSON.parse(message))).toEqual([{ t: "attach", id: "file-1", name: "proof.txt" }]);
  expect((ptys[0] as EventEmitter & { resizes: Array<[number, number]> }).resizes).toContainEqual([111, 37]);
});

test("natural exit releases every subscriber AbortSignal listener before clearing subscribers", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const firstRemove = vi.spyOn(firstAbort.signal, "removeEventListener");
  const secondRemove = vi.spyOn(secondAbort.signal, "removeEventListener");
  manager.create({ id: "listeners", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("listeners", { onData: () => {} }, undefined, { signal: firstAbort.signal });
  await manager.attach("listeners", { onData: () => {} }, undefined, { signal: secondAbort.signal });

  ptys[0]!.emit("exit", { exitCode: 0 });

  expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(secondRemove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(manager.isAttached("listeners")).toBe(false);
});

test("a delayed build completing after stop transfers cleanup exactly once", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const fake = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/delayed-token-bearing"],
  });
  fake.pauseBuild();
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: fakePtyFactory().spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "delayed", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  const attaching = manager.attach("delayed", { onData: () => {} });
  await Promise.resolve();

  manager.stop("delayed");
  fake.resumeBuild();

  await expect(attaching).resolves.toBeUndefined();
  expect(fake.cleanupCalls).toEqual([["/tmp/delayed-token-bearing"]]);
});

test("a cross-provider store collision never leaves a spawnable manager record", () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  store.upsert({
    provider: "claude",
    id: "collision",
    cwd: "/claude",
    mode: "terminal",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
  });
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 2,
    runTmux: () => {},
  });

  expect(() =>
    manager.create({
      id: "collision",
      cwd: "/codex",
      provider: "codex",
      options: { provider: "codex" },
    }),
  ).toThrow(/session id collision already exists/i);
  expect(manager.get("collision")).toBeUndefined();
});

test("duplicate live same-provider id preserves the existing process, subscribers, artifacts, and row", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", {
    executable: "/bin/codex",
    args: [],
    env: {},
    cleanupPaths: ["/tmp/original-token-bearing"],
  });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  const seen: string[] = [];
  manager.create({ id: "duplicate", cwd: "/original", provider: "codex", options: { provider: "codex" } });
  await manager.attach("duplicate", { onData: (chunk) => seen.push(chunk) });

  expect(() =>
    manager.create({ id: "duplicate", cwd: "/replacement", provider: "codex", options: { provider: "codex" } }),
  ).toThrow(/session id duplicate already exists/i);
  ptys[0]!.emit("data", "still-live");

  expect(seen).toEqual(["still-live"]);
  expect(manager.get("duplicate")?.cwd).toBe("/original");
  expect(store.get("duplicate")?.cwd).toBe("/original");
  expect(fake.cleanupCalls).toEqual([]);
});

test("duplicate stored same-provider id is rejected before persistence overwrite", () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  store.upsert({
    provider: "codex",
    id: "stored-duplicate",
    cwd: "/persisted",
    mode: "terminal",
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
    launchOptions: { provider: "codex", model: "persisted-model" },
  });
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 2,
    runTmux: () => {},
  });

  expect(() =>
    manager.create({
      id: "stored-duplicate",
      cwd: "/replacement",
      provider: "codex",
      options: { provider: "codex", model: "replacement-model" },
    }),
  ).toThrow(/session id stored-duplicate already exists/i);

  expect(manager.get("stored-duplicate")).toBeUndefined();
  expect(store.get("stored-duplicate")).toMatchObject({
    cwd: "/persisted",
    launchOptions: { model: "persisted-model" },
  });
});

test("concurrent same-provider create across SQLite connections preserves the winner and only it is spawnable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-manager-claim-race-"));
  const dbPath = join(dir, "sessions.db");
  const loserStore = openSessionStore({ dbPath });
  let winnerStore: ReturnType<typeof openSessionStore> | undefined;
  try {
    expect(loserStore.mode).toBe("sqlite");
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const loaded = require("better-sqlite3");
        const Database = loaded.default || loaded;
        const db = new Database(workerData.dbPath);
        db.pragma("journal_mode = WAL");
        db.exec("BEGIN IMMEDIATE");
        db.prepare(
          "INSERT INTO provider_sessions (id, provider, cwd, status, created_at, last_activity_at, name, provider_session_id, launch_options_json, integration_status_json) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).run("same-provider-race", "codex", "/winner", "running", 1, 1, "winner", null, JSON.stringify({ provider: "codex", model: "winner-model" }), null);
        parentPort.postMessage("locked");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
          parentPort.postMessage("committed");
        }, 250);
      `,
      { eval: true, workerData: { dbPath } },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", (message) =>
        message === "locked" ? resolve() : reject(new Error(`unexpected worker message: ${String(message)}`)),
      );
    });
    const workerExited = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
    });
    const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] });
    const { spawn, ptys } = fakePtyFactory();
    const loser = new TerminalManager({
      store: loserStore,
      providers: new ProviderRegistry([fake.provider]),
      now: () => 2,
      ptySpawn: spawn as never,
      runTmux: () => {},
    });

    let collisionError: unknown;
    try {
      loser.create({
        id: "same-provider-race",
        cwd: "/loser",
        provider: "codex",
        options: { provider: "codex", model: "loser-model" },
      });
    } catch (error) {
      collisionError = error;
    }
    await workerExited;

    expect(collisionError).toMatchObject({ message: "Session id same-provider-race already exists" });
    expect(loser.get("same-provider-race")).toBeUndefined();
    expect(loserStore.get("same-provider-race")).toMatchObject({
      cwd: "/winner",
      name: "winner",
      launchOptions: { provider: "codex", model: "winner-model" },
    });
    await expect(loser.attach("same-provider-race", { onData: () => {} })).resolves.toBeUndefined();

    winnerStore = openSessionStore({ dbPath });
    const winner = new TerminalManager({
      store: winnerStore,
      providers: new ProviderRegistry([fake.provider]),
      now: () => 3,
      ptySpawn: spawn as never,
      runTmux: () => {},
    });
    winner.rehydrate({ liveTmuxNames: ["rc-same-provider-race"] });
    await expect(winner.attach("same-provider-race", { onData: () => {} })).resolves.toBeDefined();
    expect(ptys).toHaveLength(1);
  } finally {
    winnerStore?.close();
    loserStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflicting concurrent fresh and resume attaches fail closed", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const fake = recordingProvider("codex", { executable: "/bin/codex", args: [], env: {}, cleanupPaths: [] }, (chunk) =>
    chunk === "identity" ? [{ type: "provider-session-id", id: "thread-1" }] : [],
  );
  const manager = new TerminalManager({
    store,
    providers: new ProviderRegistry([fake.provider]),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  manager.create({ id: "x", cwd: "/w", provider: "codex", options: { provider: "codex" } });
  await manager.attach("x", { onData: () => {} });
  ptys[0]!.emit("data", "identity");
  ptys[0]!.emit("exit", { exitCode: 0 });
  fake.pauseBuild();

  const fresh = manager.attach("x", { onData: () => {} }, undefined, { respawn: "fresh" });
  await expect(manager.attach("x", { onData: () => {} }, undefined, { respawn: "continue" })).rejects.toMatchObject({
    code: "RESUME_IDENTITY_UNAVAILABLE",
  });
  fake.resumeBuild();
  await fresh;

  expect(fake.buildCalls.filter((call) => call.intent === "fresh")).toHaveLength(2);
  expect(fake.buildCalls.filter((call) => call.intent === "resume")).toHaveLength(0);
});
