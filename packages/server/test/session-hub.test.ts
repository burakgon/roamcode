import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SessionManager, SessionHub, parseTranscript, transcriptToFrames } from "../src/index.js";
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

test("createSession honors an explicit starting permission mode (recorded in meta)", async () => {
  const { hub } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd(), permissionMode: "plan" });
  expect(meta.permissionMode).toBe("plan");
  // dangerouslySkip still forces bypass regardless of an explicit mode.
  const skipped = await hub.createSession({ cwd: process.cwd(), dangerouslySkip: true, permissionMode: "plan" });
  expect(skipped.permissionMode).toBe("bypassPermissions");
  hub.stopSession(meta.id);
  hub.stopSession(skipped.id);
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

test("getHistory reports turnActive in the EARLY window (sent, nothing echoed yet) so reopen shows 'working'", async () => {
  // The buffer's turnActive only flips once the CLI echoes a frame; in "silent" mode nothing is echoed, so
  // this isolates the server's `turnInFlight` signal — without it a reopen during spin-up/first-thinking
  // read a wrong "idle"/"Ready". liveWire stays undefined (no tool frames), so the client seeds "thinking".
  const { hub } = hubFor("silent");
  const meta = await hub.createSession({ cwd: process.cwd() });

  // Before any send: no turn is in flight → idle.
  const before = await hub.getHistory(meta.id);
  expect(before.live?.turnActive).toBeFalsy();

  // Send, but the mock echoes NOTHING — the buffer has no assistant/user/stream frame for this turn.
  await hub.sendMessage(meta.id, "think hard");
  const mid = await hub.getHistory(meta.id);
  expect(mid.live?.turnActive).toBe(true); // honest "working" from turnInFlight, not idle
  expect(mid.live?.liveWire).toBeUndefined(); // no tool yet → client seeds the neutral "thinking"
  hub.stopSession(meta.id);
});

test("getHistory clears turnActive after the turn settles (result) so a later reopen reads idle", async () => {
  const { hub } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });
  const done = waitForFrame(hub, meta.id, (f) => f.kind === "result");
  await hub.sendMessage(meta.id, "hi");
  await done;
  const after = await hub.getHistory(meta.id);
  expect(after.live?.turnActive).toBeFalsy(); // turnInFlight reset on result → reopen is honest "Ready"/"Done"
  hub.stopSession(meta.id);
});

test("getHistory: a freshly RESUMED dormant session reads idle, not a stuck 'thinking'", async () => {
  // REGRESSION (resume hangs on "thinking"): resume seeds the buffer with transcript frames that END on
  // an assistant turn — a transcript has no `result` line — so liveStateFromBuffer saw "activity after no
  // boundary" and reported turnActive=true / liveWire="thinking". The just-resumed chat was then pinned to
  // "thinking" forever, because no `result` ever arrives for history (the turn already finished). turnActive
  // must come from the server's authoritative in-flight flag, not the seeded history tail: a session that
  // was only resumed (no new user message) has NO turn in flight → idle.
  const { hub } = hubFor("resume");
  const jsonl = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi there" }] },
      uuid: "u1",
      timestamp: "2026-06-28T10:00:00.000Z",
      cwd: process.cwd(),
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello! How can I help?" }] },
      uuid: "a1",
      timestamp: "2026-06-28T10:00:01.000Z",
    }),
  ].join("\n");
  const frames = transcriptToFrames(parseTranscript(jsonl));
  // Guard the fixture: the seeded tail is an assistant `event` with NO result frame — the exact shape the
  // buffer heuristic mistook for an in-flight turn.
  expect(frames.at(-1)?.kind).toBe("event");
  expect(frames.some((f) => f.kind === "result")).toBe(false);

  const meta = await hub.resumeFromTranscript({ sessionId: "resume-livestate", cwd: process.cwd(), frames });
  const h = await hub.getHistory(meta.id);
  expect(h.live?.turnActive).toBe(false); // before the fix: true → the wire stuck on "thinking"
  expect(h.live?.liveWire).toBeUndefined(); // and no fabricated wire phase
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

// FOREGROUND-GATING: a subscription defaults to foreground on connect; setForeground(false) flips it; it
// drops to false when the last subscriber unsubscribes; and it is independent per session.
test("hasForegroundSubscriber: default true on connect, flips with setForeground, false with no subscriber", async () => {
  const { hub } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });

  // No subscriber yet → no foreground viewer.
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(false);

  // Subscribing defaults to FOREGROUND (opening the chat means looking at it).
  const sub = hub.subscribe(meta.id, () => {});
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(true);

  // Backgrounding the tab (a `visibility` background frame) flips it.
  sub.setForeground(false);
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(false);

  // Foregrounding again restores it.
  sub.setForeground(true);
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(true);

  // Disconnecting drops to false (nobody is looking).
  sub.unsubscribe();
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(false);

  // Unknown id → false (never a foreground viewer).
  expect(hub.hasForegroundSubscriber("nope")).toBe(false);

  hub.stopSession(meta.id);
});

test("hasForegroundSubscriber is true if ANY of several subscribers is foreground", async () => {
  const { hub } = hubFor("simple");
  const meta = await hub.createSession({ cwd: process.cwd() });
  const a = hub.subscribe(meta.id, () => {});
  const b = hub.subscribe(meta.id, () => {});
  a.setForeground(false);
  b.setForeground(false);
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(false);
  // One device foregrounds → the session has a foreground viewer again.
  b.setForeground(true);
  expect(hub.hasForegroundSubscriber(meta.id)).toBe(true);
  a.unsubscribe();
  b.unsubscribe();
  hub.stopSession(meta.id);
});

test("awaitingSessionCount counts only sessions with a pending prompt", async () => {
  const { hub } = hubFor("permission");
  const a = await hub.createSession({ cwd: process.cwd() });
  const b = await hub.createSession({ cwd: process.cwd() });
  // Neither is awaiting yet.
  expect(hub.awaitingSessionCount()).toBe(0);

  // Drive `a` to a pending permission (the mock blocks on a write approval).
  const permPromise = waitForFrame(hub, a.id, (f) => f.kind === "permission");
  hub.sendMessage(a.id, "write a file");
  const perm = await permPromise;
  expect(hub.awaitingSessionCount()).toBe(1); // only `a` is awaiting; `b` is idle

  // Answering clears it back to 0.
  const requestId = (perm.payload as { requestId: string }).requestId;
  const done = waitForFrame(hub, a.id, (f) => f.kind === "result");
  hub.answerPermission(a.id, requestId, "allow", "ok");
  await done;
  expect(hub.awaitingSessionCount()).toBe(0);

  hub.stopSession(a.id);
  hub.stopSession(b.id);
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
