import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, TerminalManager, openSessionStore } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, PushEvent, PushDispatcher } from "../src/index.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let root: string;
let current: CreateServerResult | undefined;
let pushed: PushEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-ask-"));
  pushed = [];
});

afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** A fake pty spawn so terminal sessions don't touch real tmux/node-pty. */
function fakePtySpawn(): () => EventEmitter {
  return () => {
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
    return ee;
  };
}

/** A push dispatcher that just records the events it was asked to send. */
function fakeDispatcher(): PushDispatcher {
  return {
    dispatch: async (event) => {
      pushed.push(event);
    },
  };
}

function makeServer(): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: root,
    dataDir: join(root, ".data"),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
  const store = openSessionStore({ dbPath: ":memory:" });
  const terminalManager = new TerminalManager({
    store,
    claudeBin: config.claude.claudeBin,
    now: () => Date.now(),
    ptySpawn: fakePtySpawn() as never,
    runTmux: () => {},
  });
  return createServer(config, { store, terminalAvailable: true, terminalManager, pushDispatcher: fakeDispatcher() });
}

const QUESTIONS = [{ question: "Which language?", header: "Language", options: [{ label: "TS" }, { label: "Py" }] }];

/** Yield to the event loop until `pred()` is true (the long-poll handler runs asynchronously via inject). */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("waitFor timed out");
}

/** Attach a control-frame collector to a session (mirrors the WS onControl sink). */
function collectControl(
  result: CreateServerResult,
  id: string,
): { frames: { t?: string; askId?: string }[]; stop: () => void } {
  const frames: { t?: string; askId?: string }[] = [];
  const sub = result.terminalManager.attach(id, {
    onData: () => {},
    onControl: (json) => frames.push(JSON.parse(json)),
  });
  return { frames, stop: () => sub?.unsubscribe() };
}

test("POST /ask 404s for an unknown session and 400s for empty questions", async () => {
  current = makeServer();
  current.terminalManager.create({ id: "s1", cwd: root });

  const unknown = await current.app.inject({
    method: "POST",
    url: "/sessions/nope/ask",
    headers: auth,
    payload: { questions: QUESTIONS },
  });
  expect(unknown.statusCode).toBe(404);

  const empty = await current.app.inject({
    method: "POST",
    url: "/sessions/s1/ask",
    headers: auth,
    payload: { questions: [] },
  });
  expect(empty.statusCode).toBe(400);
});

test("POST /ask delivers an `ask` frame + sets awaiting (NO push while watching), then resolves on answer", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });
  const { frames, stop } = collectControl(current, id); // a client is attached (watching)

  // Fire the long-poll (don't await yet) and let the handler register + deliver the ask frame.
  const askPromise = current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask`,
    headers: auth,
    payload: { questions: QUESTIONS },
  });
  await waitFor(() => frames.some((f) => f.t === "ask"));

  const askFrame = frames.find((f) => f.t === "ask");
  expect(askFrame).toBeDefined();
  const askId = askFrame!.askId!;
  expect(typeof askId).toBe("string");
  // claude is blocked → awaiting flag set + the in-band frame delivered; but NO push — you're right there
  // watching (same gate as the Stop hook).
  expect(current.terminalManager.get(id)?.awaiting).toBe(true);
  expect(pushed.some((e) => e.kind === "ask")).toBe(false);

  // The user answers.
  const answerRes = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask/answer`,
    headers: auth,
    payload: { askId, answers: { "Which language?": "Py" } },
  });
  expect(answerRes.statusCode).toBe(200);

  // The held /ask request now returns the answer, and awaiting is cleared.
  const askRes = await askPromise;
  stop();
  expect(askRes.statusCode).toBe(200);
  expect(askRes.json()).toEqual({ answers: { "Which language?": "Py" } });
  expect(current.terminalManager.get(id)?.awaiting).toBe(false);
});

test("POST /ask PUSHES (with a badgeCount) when NOBODY is watching", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });

  // No client attached → the ask should push the phone. Fire the long-poll; don't await yet.
  const askPromise = current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask`,
    headers: auth,
    payload: { questions: QUESTIONS },
  });
  await waitFor(() => pushed.some((e) => e.kind === "ask" && e.sessionId === id));
  const ask = pushed.find((e) => e.kind === "ask");
  expect(ask?.detail).toBe("Language"); // the first question's header enriches the body
  expect(ask?.badgeCount).toBe(1); // this one session is now awaiting → home-screen badge = 1

  // Clean up the in-flight long-poll so the test doesn't wait for the 30-min timeout.
  const del = await current.app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth });
  expect(del.statusCode).toBe(204);
  expect((await askPromise).json()).toEqual({ cancelled: true });
});

test("away-from-desk pushes carry badgeCount = the number of sessions awaiting you", async () => {
  current = makeServer();
  current.terminalManager.create({ id: "s1", cwd: root });
  current.terminalManager.create({ id: "s2", cwd: root });
  current.terminalManager.setAwaiting("s1", true); // one session already awaiting

  // A Stop hook on s2 (nobody attached) → pushes; the badge counts s1 + s2 = 2.
  const res = await current.app.inject({ method: "POST", url: "/sessions/s2/hook?event=stop", headers: auth });
  expect(res.statusCode).toBe(200);
  const awaiting = pushed.find((e) => e.kind === "awaiting" && e.sessionId === "s2");
  expect(awaiting?.badgeCount).toBe(2);
});

test("POST /ask/answer with cancelled resolves the ask as cancelled", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });
  const { frames, stop } = collectControl(current, id);

  const askPromise = current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask`,
    headers: auth,
    payload: { questions: QUESTIONS },
  });
  await waitFor(() => frames.some((f) => f.t === "ask"));
  const askId = frames.find((f) => f.t === "ask")!.askId!;

  const answerRes = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask/answer`,
    headers: auth,
    payload: { askId, cancelled: true },
  });
  expect(answerRes.statusCode).toBe(200);
  const askRes = await askPromise;
  stop();
  expect(askRes.json()).toEqual({ cancelled: true });
});

test("POST /ask/answer 400s without an askId and 404s for an unknown/expired askId", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });

  const noId = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask/answer`,
    headers: auth,
    payload: { answers: {} },
  });
  expect(noId.statusCode).toBe(400);

  const unknown = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask/answer`,
    headers: auth,
    payload: { askId: "nope", answers: {} },
  });
  expect(unknown.statusCode).toBe(404);
});

test("closing a session resolves an in-flight ask as cancelled (no hang)", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });

  const askPromise = current.app.inject({
    method: "POST",
    url: `/sessions/${id}/ask`,
    headers: auth,
    payload: { questions: QUESTIONS },
  });
  await waitFor(() => current!.terminalManager.get(id)?.awaiting === true); // ask registered

  const del = await current.app.inject({ method: "DELETE", url: `/sessions/${id}`, headers: auth });
  expect(del.statusCode).toBe(204);

  const askRes = await askPromise; // must resolve (cancelled), not hang until the 5-min timeout
  expect(askRes.json()).toEqual({ cancelled: true });
});

test("POST /attach fires a 'file' push", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });
  writeFileSync(join(root, "shot.png"), "img-bytes");

  const res = await current.app.inject({
    method: "POST",
    url: `/sessions/${id}/attach`,
    headers: auth,
    payload: { path: join(root, "shot.png"), kind: "image" },
  });
  expect(res.statusCode).toBe(200);
  const fileEvent = pushed.find((e) => e.kind === "file" && e.sessionId === id);
  expect(fileEvent).toBeDefined();
  expect(fileEvent!.detail).toBe("shot.png");
  expect(fileEvent!.badgeCount).toBe(0); // nothing awaiting → the badge is cleared (0)
});

test("GET /sessions exposes the awaiting flag", async () => {
  current = makeServer();
  const id = "s1";
  current.terminalManager.create({ id, cwd: root });
  current.terminalManager.setAwaiting(id, true);
  const res = await current.app.inject({ method: "GET", url: "/sessions", headers: auth });
  expect(res.statusCode).toBe(200);
  const session = res.json().sessions.find((s: { id: string }) => s.id === id);
  expect(session.awaiting).toBe(true);
});

test("POST /ask and /ask/answer are token-gated (401 without auth)", async () => {
  current = makeServer();
  current.terminalManager.create({ id: "s1", cwd: root });
  const ask = await current.app.inject({ method: "POST", url: "/sessions/s1/ask", payload: { questions: QUESTIONS } });
  expect(ask.statusCode).toBe(401);
  const answer = await current.app.inject({ method: "POST", url: "/sessions/s1/ask/answer", payload: { askId: "x" } });
  expect(answer.statusCode).toBe(401);
});

test("POST /hook?event=stop marks awaiting + pushes when nobody is watching; 404 for unknown session", async () => {
  current = makeServer();
  const id = "hk1";
  current.terminalManager.create({ id, cwd: root });

  const unknown = await current.app.inject({ method: "POST", url: "/sessions/nope/hook?event=stop", headers: auth });
  expect(unknown.statusCode).toBe(404);

  const stop = await current.app.inject({ method: "POST", url: `/sessions/${id}/hook?event=stop`, headers: auth });
  expect(stop.statusCode).toBe(200);
  expect(current.terminalManager.get(id)?.awaiting).toBe(true);
  expect(pushed.map((p) => p.kind)).toContain("awaiting"); // nobody watching → away-from-desk push
});

test("POST /hook?event=stop does NOT push while a client is watching (badge only)", async () => {
  current = makeServer();
  const id = "hk2";
  current.terminalManager.create({ id, cwd: root });
  const watcher = collectControl(current, id); // a client is attached
  const res = await current.app.inject({ method: "POST", url: `/sessions/${id}/hook?event=stop`, headers: auth });
  expect(res.statusCode).toBe(200);
  expect(current.terminalManager.get(id)?.awaiting).toBe(true); // flag still flips (for the badge)
  expect(pushed).toEqual([]); // ...but no push — you're right there watching
  watcher.stop();
});

test("POST /hook?event=submit clears awaiting; an unknown event is 400", async () => {
  current = makeServer();
  const id = "hk3";
  current.terminalManager.create({ id, cwd: root });
  current.terminalManager.setAwaiting(id, true);
  const submit = await current.app.inject({ method: "POST", url: `/sessions/${id}/hook?event=submit`, headers: auth });
  expect(submit.statusCode).toBe(200);
  expect(current.terminalManager.get(id)?.awaiting).toBe(false);

  const bad = await current.app.inject({ method: "POST", url: `/sessions/${id}/hook?event=whoops`, headers: auth });
  expect(bad.statusCode).toBe(400);
});
