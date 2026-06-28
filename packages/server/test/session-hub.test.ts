import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SessionManager, SessionHub } from "../src/index.js";
import type { ServerFrame, HistoryService } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function hubFor(mode: string) {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: mode }, startTimeoutMs: 5000 },
  );
  return { hub: new SessionHub(manager), manager };
}

/** Resolve once a frame matching `pred` arrives on the subscription. */
function waitForFrame(hub: SessionHub, id: string, pred: (f: ServerFrame) => boolean): Promise<ServerFrame> {
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
  const { hub } = hubFor("simple");
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
  const { hub } = hubFor("permission");
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
  const { hub } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });

  // Drive a full turn with a first subscriber, wait for its result.
  const firstResult = waitForFrame(hub, meta.id, (f) => f.kind === "result");
  hub.sendMessage(meta.id, "hi");
  await firstResult;

  // A brand-new subscriber (simulating reconnect) must immediately get the buffered frames.
  const replayed: ServerFrame[] = [];
  const sub = hub.subscribe(meta.id, (f) => replayed.push(f));
  sub.unsubscribe();
  expect(replayed.some((f) => f.kind === "result")).toBe(true);
  expect(replayed.length).toBeGreaterThan(0);

  // getHistory now returns { history, sinceSeq }. With no HistoryService wired it mirrors the buffer,
  // and sinceSeq is the buffer's max seq (so the WS resumes from there).
  const history = await hub.getHistory(meta.id);
  expect(history.history.some((f) => f.kind === "result")).toBe(true);
  expect(history.sinceSeq).toBeGreaterThan(0);
  hub.stopSession(meta.id);
});

test("a reconnect whose ?since= is below evicted content gets a `resync` signal first (no silent gap)", async () => {
  // A tiny replay buffer guarantees that one turn's frames evict the earlier (init) content, so a client
  // that reconnects from seq 0 can no longer be made whole by a delta — it must refetch full history.
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 },
  );
  const hub = new SessionHub(manager, { replayCapacity: 1 });
  const meta = await hub.createSession({ cwd: process.cwd() });

  const firstResult = waitForFrame(hub, meta.id, (f) => f.kind === "result");
  hub.sendMessage(meta.id, "hi");
  await firstResult;

  // Reconnect from the very start (since=0): the buffer evicted earlier content, so the server MUST
  // tell us to resync — and it must be the FIRST thing the client hears.
  const stale: ServerFrame[] = [];
  const staleSub = hub.subscribe(meta.id, (f) => stale.push(f), 0);
  staleSub.unsubscribe();
  expect(stale[0]?.kind).toBe("resync");

  // A reconnect that's already caught up (since = the buffer's max) has no gap → no resync.
  const fresh: ServerFrame[] = [];
  const freshSub = hub.subscribe(meta.id, (f) => fresh.push(f), (await hub.getHistory(meta.id)).sinceSeq);
  freshSub.unsubscribe();
  expect(fresh.some((f) => f.kind === "resync")).toBe(false);

  hub.stopSession(meta.id);
});

test("getHistory windows to the last N turns (truncated + slim raw); no limit returns the full history", async () => {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 },
  );
  // A stub transcript of 10 turns so we can assert the window math without writing a real .jsonl.
  const turns = Array.from({ length: 10 }, (_, i) => ({
    type: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] },
    uuid: `t${i}`,
  }));
  const history = {
    claudeHome: "/x",
    transcriptPath: () => "/x/s.jsonl",
    read: async () => turns,
  } as unknown as HistoryService;
  const hub = new SessionHub(manager, { history });
  const meta = await hub.createSession({ cwd: process.cwd() });

  // Default-style windowed read: only the LAST 4 turns, flagged truncated, with the true total.
  const win = await hub.getHistory(meta.id, 4);
  expect(win.history).toHaveLength(4);
  expect(win.truncated).toBe(true);
  expect(win.total).toBe(10);
  expect((win.history[0]!.payload as { uuid: string }).uuid).toBe("t6"); // last 4 = t6..t9
  // raw is SLIM — it must NOT carry the duplicated message (that was the payload-doubling bug).
  const raw = (win.history[0]!.payload as { raw: Record<string, unknown> }).raw;
  expect(raw).not.toHaveProperty("message");
  expect(raw.uuid).toBe("t6");

  // No limit → the entire transcript, not truncated.
  const full = await hub.getHistory(meta.id);
  expect(full.history).toHaveLength(10);
  expect(full.truncated).toBe(false);

  hub.stopSession(meta.id);
});

test("getHistory slim raw carries isCompactSummary so a reopened compaction renders the clean marker", async () => {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 },
  );
  const turns = [
    // The post-compaction seed: isCompactSummary, NOT isMeta (the giant "YOU" bubble bug).
    {
      type: "user" as const,
      message: { role: "user", content: "This session is being continued…" },
      uuid: "cs1",
      isCompactSummary: true,
    },
    { type: "user" as const, message: { role: "user", content: [{ type: "text", text: "typed" }] }, uuid: "u1" },
  ];
  const history = {
    claudeHome: "/x",
    transcriptPath: () => "/x/s.jsonl",
    read: async () => turns,
  } as unknown as HistoryService;
  const hub = new SessionHub(manager, { history });
  const meta = await hub.createSession({ cwd: process.cwd() });

  const { history: frames } = await hub.getHistory(meta.id);
  expect((frames[0]!.payload as { raw: { isCompactSummary?: boolean } }).raw.isCompactSummary).toBe(true);
  expect((frames[1]!.payload as { raw: { isCompactSummary?: boolean } }).raw.isCompactSummary).toBeUndefined();

  hub.stopSession(meta.id);
});

test("getHistory forwards parentToolUseId so reopened subagent turns route into their thread (not main)", async () => {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 },
  );
  const turns = [
    {
      type: "assistant" as const,
      message: { role: "assistant", content: [{ type: "text", text: "main" }] },
      uuid: "m1",
    },
    // A subagent's own (sidechain) line carrying its Agent tool_use id.
    {
      type: "assistant" as const,
      message: { role: "assistant", content: [{ type: "text", text: "sub" }] },
      uuid: "s1",
      parentToolUseId: "ag1",
    },
  ];
  const history = {
    claudeHome: "/x",
    transcriptPath: () => "/x/s.jsonl",
    read: async () => turns,
  } as unknown as HistoryService;
  const hub = new SessionHub(manager, { history });
  const meta = await hub.createSession({ cwd: process.cwd() });

  const { history: frames } = await hub.getHistory(meta.id);
  expect((frames[0]!.payload as { parentToolUseId?: string }).parentToolUseId).toBeUndefined();
  expect((frames[1]!.payload as { parentToolUseId?: string }).parentToolUseId).toBe("ag1");

  hub.stopSession(meta.id);
});

test("pushAttachment emits an attachment frame to live subscribers and buffers it for replay", async () => {
  const { hub } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });

  const live: ServerFrame[] = [];
  const sub = hub.subscribe(meta.id, (f) => live.push(f));
  const payload = { id: "att-1", path: "/r/a.png", name: "a.png", caption: "look", isImage: true };
  hub.pushAttachment(meta.id, payload);
  sub.unsubscribe();

  const frame = live.find((f) => f.kind === "attachment");
  expect(frame).toBeDefined();
  expect(frame!.payload).toEqual(payload);
  expect(typeof frame!.seq).toBe("number");

  // Buffered: a fresh (reconnecting) subscriber replays it.
  const replayed: ServerFrame[] = [];
  const sub2 = hub.subscribe(meta.id, (f) => replayed.push(f));
  sub2.unsubscribe();
  expect(replayed.some((f) => f.kind === "attachment")).toBe(true);

  hub.stopSession(meta.id);
});

test("pushAttachment throws for an unknown session id", () => {
  const { hub } = hubFor("simple");
  expect(() => hub.pushAttachment("nope", { id: "x", path: "/p", name: "p", isImage: false })).toThrow();
});

test("unknown ids throw on hub operations", async () => {
  const { hub } = hubFor("simple");
  // sendMessage/answerPermission/getHistory are async now — they REJECT for an unknown id.
  await expect(hub.sendMessage("nope", "x")).rejects.toThrow();
  await expect(hub.answerPermission("nope", "r", "allow")).rejects.toThrow();
  await expect(hub.getHistory("nope")).rejects.toThrow();
  // subscribe is still synchronous.
  expect(() => hub.subscribe("nope", () => {})).toThrow();
});

test('an "error" emitted by a hub-managed process does not throw and becomes a diagnostic frame', async () => {
  // Node's EventEmitter throws on an "error" event with no listener attached, which
  // would crash the server. The hub MUST attach an "error" listener to every
  // ClaudeProcess it manages (folded into a diagnostic frame per the plan).
  const { hub, manager } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });

  const frames: ServerFrame[] = [];
  const sub = hub.subscribe(meta.id, (f) => frames.push(f));

  const proc = manager.getSession(meta.id)!.process;
  // This is exactly what ClaudeProcess.write() does on a write-after-teardown.
  expect(() => proc.emit("error", new Error("write after teardown"))).not.toThrow();

  const diag = frames.find((f) => f.kind === "diagnostic");
  expect(diag).toBeDefined();
  expect((diag!.payload as { message: string }).message).toBe("write after teardown");
  expect(hub.getSession(meta.id)?.status).toBe("errored");

  sub.unsubscribe();
  hub.stopSession(meta.id);
});
