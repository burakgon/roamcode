// packages/server/test/terminal-manager.test.ts
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalManager } from "../src/terminal-manager.js";
import { openSessionStore } from "../src/session-store.js";

/** A pty spawn that records the argv of every spawn, so a test can assert what flags claude was launched
 *  with. Returns a minimal IPty-shaped stub. */
function argCapturingSpawn() {
  const spawnedArgv: string[][] = [];
  const spawn = ((_file: string, args: string[]) => {
    if (Array.isArray(args)) spawnedArgv.push(args);
    const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
    ee.write = () => {};
    ee.resize = () => {};
    ee.kill = () => {};
    ee.onData = () => {};
    ee.onExit = () => {};
    return ee;
  }) as never;
  return { spawn, spawnedArgv };
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
    claudeBin: "claude",
    now: () => ++t,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  return { m, store, ptys };
}

test("create persists a terminal row; attach spawns pty and fans data", () => {
  const { m, store, ptys } = mgr();
  const meta = m.create({ id: "s1", cwd: "/w" });
  expect(meta.mode).toBe("terminal");
  expect(store.get("s1")?.mode).toBe("terminal");

  const seen: string[] = [];
  const sub = m.attach("s1", { onData: (d) => seen.push(d) });
  expect(sub).toBeDefined();
  ptys[0]!.emit("data", "redraw");
  expect(seen).toEqual(["redraw"]);
});

test("create derives model + effort from the spawn args (source of truth, like dangerouslySkip)", () => {
  const { m } = mgr();
  const meta = m.create({ id: "e1", cwd: "/w", claudeArgs: ["--model", "opus", "--effort", "max"] });
  expect(meta.model).toBe("opus");
  expect(meta.effort).toBe("max");
  // No flags → undefined (claude's own default), never a crash.
  const bare = m.create({ id: "e2", cwd: "/w" });
  expect(bare.model).toBeUndefined();
  expect(bare.effort).toBeUndefined();
});

test("spawn flags survive a server RESTART: rehydrate restores the meta + a respawn re-runs with them", () => {
  // The ended-overlay Restart used to spawn a BARE claude after a server restart (rehydrate wiped claudeArgs
  // to []) — so danger/model/effort were silently dropped. Now the user flags are persisted + restored.
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, spawnedArgv } = argCapturingSpawn();
  const mk = () =>
    new TerminalManager({ store, claudeBin: "claude", now: () => 1, ptySpawn: spawn, runTmux: () => {} });

  mk().create({
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

  // … and a respawn re-runs claude with the SAME flags, not a bare process.
  m2.attach("s1", { onData: () => {} });
  const argv = (spawnedArgv.at(-1) ?? []).join(" ");
  expect(argv).toContain("--model opus");
  expect(argv).toContain("--effort max");
  expect(argv).toContain("--dangerously-skip-permissions");
});

test("a rehydrated session REGENERATES its MCP + hooks configs on respawn (attachments + needs-you survive)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-tm-"));
  try {
    const store = openSessionStore({ dbPath: ":memory:" });
    const { spawn, spawnedArgv } = argCapturingSpawn();
    const mk = () =>
      new TerminalManager({ store, claudeBin: "claude", now: () => 1, ptySpawn: spawn, runTmux: () => {} });
    mk().create({ id: "s1", cwd: "/w", claudeArgs: ["--effort", "high"] });

    const m2 = mk();
    // attachConfig is only set AFTER boot rehydrate in prod — so the configs can't be written during rehydrate
    // and must be regenerated at respawn. Set it here (as start.ts does post-listen) then rehydrate + respawn.
    m2.setAttachConfig({ baseUrl: "http://127.0.0.1:1", token: "tok", mcpScriptPath: "/x/mcp-send.js", dataDir: dir });
    m2.rehydrate({ liveTmuxNames: ["rc-s1"] });
    m2.attach("s1", { onData: () => {} });

    const argv = (spawnedArgv.at(-1) ?? []).join(" ");
    expect(argv).toContain("--effort high"); // the user flag survived …
    expect(argv).toContain("--mcp-config"); // … and the per-session configs were regenerated for the respawn
    expect(argv).toContain("--settings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehydrate marks stored terminal sessions whose tmux session is alive", () => {
  const { m, store } = mgr();
  store.upsert({
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

test("stop kills and removes", () => {
  const { m } = mgr();
  m.create({ id: "x", cwd: "/w" });
  m.attach("x", { onData: () => {} });
  m.stop("x");
  expect(m.get("x")).toBeUndefined();
});

test("pushControl fans a JSON control message (attachment) to attached subscribers", () => {
  const { m } = mgr();
  m.create({ id: "c", cwd: "/w" });
  const control: string[] = [];
  m.attach("c", { onData: () => {}, onControl: (msg) => control.push(msg) });
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
    claudeBin: "claude",
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

test("awaiting STICKS across pty output (claude repainting the idle prompt); only input clears it", () => {
  const { m, ptys } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  m.attach("a", { onData: () => {} });
  m.setAwaiting("a", true); // e.g. the capture-pane monitor flagged a decision prompt
  expect(m.get("a")?.awaiting).toBe(true);
  ptys[0]!.emit("data", "cursor/spinner repaint while claude waits"); // MUST NOT clear it (the old bug)
  expect(m.get("a")?.awaiting).toBe(true);
  m.write("a", "y"); // user input (or the UserPromptSubmit hook) clears it
  expect(m.get("a")?.awaiting).toBe(false);
});

test("isAttached reflects whether a client is connected", () => {
  const { m } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  expect(m.isAttached("a")).toBe(false);
  const sub = m.attach("a", { onData: () => {} });
  expect(m.isAttached("a")).toBe(true);
  sub!.unsubscribe();
  expect(m.isAttached("a")).toBe(false);
  expect(m.isAttached("nope")).toBe(false);
});

test("reattach to a still-running session forces a tmux redraw (size wiggle) so a fresh xterm isn't blank", () => {
  vi.useFakeTimers();
  const { m, ptys } = mgr();
  m.create({ id: "a", cwd: "/w" });
  m.attach("a", { onData: () => {} }, { cols: 80, rows: 24 }); // first client → spawns the pty (tmux draws naturally)
  const pty = ptys[0]! as EventEmitter & { resizes: Array<[number, number]> };
  const before = pty.resizes.length;
  m.attach("a", { onData: () => {} }, { cols: 80, rows: 24 }); // SECOND client reattaches to the LIVE pty (the bug case)
  vi.advanceTimersByTime(300); // let the deferred wiggle fire
  const wiggle = pty.resizes.slice(before);
  expect(wiggle[0]).toEqual([80, 25]); // +1 row → SIGWINCH → tmux redraws the whole screen
  expect(wiggle[wiggle.length - 1]).toEqual([80, 24]); // ...then restored to the real viewport size
  vi.useRealTimers();
});

test("walk-away ping: detaching the last client WHILE awaiting fires onAwaiting (you left it waiting)", () => {
  const { m, awaiting } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  const sub = m.attach("a", { onData: () => {} });
  m.setAwaiting("a", true); // claude's Stop hook fired while you were watching
  expect(awaiting).toEqual([]); // someone is watching → no push, just the flag
  sub!.unsubscribe(); // walked away while it was waiting → now fire the away-from-desk ping
  expect(awaiting).toEqual(["a"]);
});

test("onFinished fires when claude exits, and an ended session is not awaiting", () => {
  const { m, ptys, finished } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  m.attach("a", { onData: () => {} });
  m.setAwaiting("a", true);
  expect(m.get("a")?.awaiting).toBe(true);
  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(finished).toEqual(["a"]);
  expect(m.get("a")?.awaiting).toBe(false);
  expect(m.get("a")?.status).toBe("ended");
});

test("onFinished reports wasAttached (true) — captured before the subs are torn down", () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const calls: Array<{ id: string; wasAttached: boolean }> = [];
  const m = new TerminalManager({
    store,
    claudeBin: "claude",
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
    onFinished: (id, wasAttached) => calls.push({ id, wasAttached }),
  });
  m.create({ id: "a", cwd: "/w" });
  m.attach("a", { onData: () => {} }); // a client is watching → the pty spawns
  ptys[0]!.emit("exit", { exitCode: 0 });
  // The transport gates the away-from-desk "finished" push on !wasAttached (an attached client already sees
  // the WS close); here a client was attached at exit, so wasAttached is reported true.
  expect(calls).toEqual([{ id: "a", wasAttached: true }]);
});

test("awaitingCount counts only the sessions currently awaiting you (drives the push badge)", () => {
  const { m } = mgr();
  m.create({ id: "a", cwd: "/w" });
  m.create({ id: "b", cwd: "/w" });
  m.create({ id: "c", cwd: "/w" });
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
    claudeBin: "claude",
    now: () => ++t,
    ptySpawn: spawn as never,
    runTmux: () => {},
    onAwaiting: (id) => pushed.push(id),
    capturePane: (name) => Promise.resolve(panes[name] ?? ""),
  });
  for (const id of ["work", "agent", "block", "idle"]) m.create({ id, cwd: "/w" });

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
  const skip = m.create({ id: "sk", cwd: "/w", claudeArgs: ["--dangerously-skip-permissions"] });
  expect(skip.dangerouslySkip).toBe(true);
  expect(store.get("sk")?.dangerouslySkip).toBe(true);
  const safe = m.create({ id: "safe", cwd: "/w", claudeArgs: ["--model", "opus"] });
  expect(safe.dangerouslySkip).toBe(false);
  expect(store.get("safe")?.dangerouslySkip).toBe(false);
});

test("rehydrate preserves the persisted dangerouslySkip flag", () => {
  const { m, store } = mgr();
  store.upsert({
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
  m.create({ id: "a", cwd: "/w" });
  m.setAwaiting("a", true);
  expect(m.get("a")?.awaiting).toBe(true);
  m.setAwaiting("a", false);
  expect(m.get("a")?.awaiting).toBe(false);
  expect(() => m.setAwaiting("nope", true)).not.toThrow(); // unknown id is a no-op
});

test("attachment frames are buffered and replayed to a client that connects later", () => {
  const { m } = mgr();
  m.create({ id: "a", cwd: "/w" });
  // A file arrives while nobody is attached — pushControl reaches no live client, but it's buffered.
  expect(m.pushControl("a", { t: "attach", id: "f1", name: "a.png", isImage: true })).toBe(true);
  expect(m.pushControl("a", { t: "attach", id: "f2", name: "b.txt", isImage: false })).toBe(true);

  // A client (re)connects → it receives the buffered attachments so its Files panel is correct.
  const replayed: unknown[] = [];
  m.attach("a", { onData: () => {}, onControl: (json) => replayed.push(JSON.parse(json)) });
  expect(replayed).toEqual([
    { t: "attach", id: "f1", name: "a.png", isImage: true },
    { t: "attach", id: "f2", name: "b.txt", isImage: false },
  ]);
});

test("non-attach control frames are NOT buffered for replay", () => {
  const { m } = mgr();
  m.create({ id: "a", cwd: "/w" });
  m.pushControl("a", { t: "note", detail: "not an attachment" });
  const replayed: unknown[] = [];
  m.attach("a", { onData: () => {}, onControl: (json) => replayed.push(JSON.parse(json)) });
  expect(replayed).toEqual([]); // only `attach` frames are buffered for replay; other frames are live-only
});

test("respawn=continue: only an ENDED session's respawn gets --continue, exactly once, without persisting it", () => {
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
    claudeBin: "claude",
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });
  m.create({ id: "r", cwd: "/w", claudeArgs: ["--model", "opus"] });

  // FIRST spawn of a RUNNING session: respawn=continue must be IGNORED (nothing to resume).
  m.attach("r", { onData: () => {} }, undefined, { respawn: "continue" });
  expect(spawnArgs[0]!.filter((a) => a === "--continue")).toHaveLength(0);

  // claude exits → the session is ENDED; a respawn=continue reattach appends --continue EXACTLY ONCE.
  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(m.get("r")?.status).toBe("ended");
  m.attach("r", { onData: () => {} }, undefined, { respawn: "continue" });
  expect(spawnArgs[1]!.filter((a) => a === "--continue")).toHaveLength(1);
  // --continue is appended AFTER the stored args (claude reads the last occurrence of a repeated flag).
  expect(spawnArgs[1]!.indexOf("--continue")).toBeGreaterThan(spawnArgs[1]!.indexOf("--model"));

  // The STORED args were not mutated: a later PLAIN respawn spawns without --continue (and still
  // carries the original args).
  ptys[1]!.emit("exit", { exitCode: 0 });
  m.attach("r", { onData: () => {} });
  expect(spawnArgs[2]!.filter((a) => a === "--continue")).toHaveLength(0);
  expect(spawnArgs[2]!).toContain("--model");

  // And an explicit respawn=fresh behaves like today's default.
  ptys[2]!.emit("exit", { exitCode: 0 });
  m.attach("r", { onData: () => {} }, undefined, { respawn: "fresh" });
  expect(spawnArgs[3]!.filter((a) => a === "--continue")).toHaveLength(0);
});

test("detaching the last subscriber stops the pty without killing the tmux session", () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn } = fakePtyFactory();
  const tmuxCalls: string[][] = [];
  const m = new TerminalManager({
    store,
    claudeBin: "claude",
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux: (a) => tmuxCalls.push(a),
  });
  m.create({ id: "d1", cwd: "/w" });
  const sub = m.attach("d1", { onData: () => {} });
  sub!.unsubscribe();
  // detach must NOT kill the tmux session — tmux persists so a reconnect can re-attach
  expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  expect(m.get("d1")).toBeDefined();
});
