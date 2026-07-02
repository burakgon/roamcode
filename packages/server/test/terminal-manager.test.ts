// packages/server/test/terminal-manager.test.ts
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalManager } from "../src/terminal-manager.js";
import { openSessionStore } from "../src/session-store.js";

function fakePtyFactory() {
  const ptys: EventEmitter[] = [];
  const spawn = () => {
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

/** A manager wired with awaiting notifiers + a tiny idle window, on fake timers. */
function awaitMgr(idleMs = 50) {
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
    awaitIdleMs: idleMs,
    onAwaiting: (id) => awaiting.push(id),
    onFinished: (id) => finished.push(id),
  });
  return { m, ptys, awaiting, finished, idleMs };
}

afterEach(() => {
  vi.useRealTimers();
});

test("awaiting: pty going output-idle after a burst flips awaiting true; input/output clears it", () => {
  vi.useFakeTimers();
  const { m, ptys, idleMs } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  m.attach("a", { onData: () => {} });
  ptys[0]!.emit("data", "some output"); // a burst arms the idle timer
  expect(m.get("a")?.awaiting).toBe(false);
  vi.advanceTimersByTime(idleMs + 1);
  expect(m.get("a")?.awaiting).toBe(true); // idle after the burst → awaiting

  ptys[0]!.emit("data", "more output"); // fresh output → active again
  expect(m.get("a")?.awaiting).toBe(false);
  vi.advanceTimersByTime(idleMs + 1);
  expect(m.get("a")?.awaiting).toBe(true);

  m.write("a", "x"); // user input → not awaiting
  expect(m.get("a")?.awaiting).toBe(false);
});

test("awaiting: onAwaiting is NOT fired while a client watches, but IS fired when the last one detaches", () => {
  vi.useFakeTimers();
  const { m, ptys, awaiting, idleMs } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  const sub = m.attach("a", { onData: () => {} });
  ptys[0]!.emit("data", "output");
  vi.advanceTimersByTime(idleMs + 1);
  expect(m.get("a")?.awaiting).toBe(true);
  expect(awaiting).toEqual([]); // someone is watching → no push, just the flag

  sub!.unsubscribe(); // walked away while claude was waiting → now fire the away-from-desk ping
  expect(awaiting).toEqual(["a"]);
});

test("awaiting: the idle timer fires onAwaiting only when no client is attached", () => {
  vi.useFakeTimers();
  const { m, ptys, awaiting, idleMs } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  // Attach (to spawn the pty + capture the data handler), emit output, then detach BEFORE the idle window.
  const sub = m.attach("a", { onData: () => {} });
  ptys[0]!.emit("data", "output");
  sub!.unsubscribe(); // detaches; awaiting still false, idle timer still pending
  expect(awaiting).toEqual([]);
  vi.advanceTimersByTime(idleMs + 1); // fires with subs.size === 0 → push
  expect(m.get("a")?.awaiting).toBe(true);
  expect(awaiting).toEqual(["a"]);
});

test("onFinished fires when claude exits, and an ended session is not awaiting", () => {
  vi.useFakeTimers();
  const { m, ptys, finished, idleMs } = awaitMgr();
  m.create({ id: "a", cwd: "/w" });
  m.attach("a", { onData: () => {} });
  ptys[0]!.emit("data", "output");
  vi.advanceTimersByTime(idleMs + 1);
  expect(m.get("a")?.awaiting).toBe(true);
  ptys[0]!.emit("exit", { exitCode: 0 });
  expect(finished).toEqual(["a"]);
  expect(m.get("a")?.awaiting).toBe(false);
  expect(m.get("a")?.status).toBe("ended");
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
  m.pushControl("a", { t: "ask", askId: "q1", questions: [] });
  const replayed: unknown[] = [];
  m.attach("a", { onData: () => {}, onControl: (json) => replayed.push(JSON.parse(json)) });
  expect(replayed).toEqual([]); // ask has its own replay path (the transport), so it isn't buffered here
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
