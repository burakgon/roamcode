import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./store";
import type { ServerFrame, SessionMeta } from "../types/server";

function ev(seq: number, payload: unknown): ServerFrame {
  return { seq, kind: "event", payload };
}

const meta: SessionMeta = { id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 };

beforeEach(() => {
  useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, views: {}, lastActiveAt: {} });
});

describe("useStore", () => {
  it("setToken / setSessions / setActive update state", () => {
    useStore.getState().setToken("tok");
    useStore.getState().setSessions([meta]);
    useStore.getState().setActive("s1");
    const s = useStore.getState();
    expect(s.token).toBe("tok");
    expect(s.sessions).toEqual([meta]);
    expect(s.activeSessionId).toBe("s1");
  });

  it("setUpdateInfo / setUpdateState drive the OTA update UX", () => {
    const info = {
      current: "v2026.06.20 · a",
      latest: "v2026.06.25 · b",
      behind: 3,
      updatable: true,
      updateAvailable: true,
      changelog: [],
    };
    useStore.getState().setUpdateInfo(info);
    useStore.getState().setUpdateState("updating");
    expect(useStore.getState().updateInfo).toEqual(info);
    expect(useStore.getState().updateState).toBe("updating");
    useStore.getState().setUpdateState("failed");
    expect(useStore.getState().updateState).toBe("failed");
    useStore.getState().setUpdateInfo(undefined);
    expect(useStore.getState().updateInfo).toBeUndefined();
  });

  it("setUsage stores the latest usage snapshot (and clears it with null)", () => {
    expect(useStore.getState().usage).toBeUndefined();
    const usage = {
      session: { percent: 12, resets: "Jun 25 at 11:30pm" },
      week: { percent: 72, resets: "Jun 25 at 10pm" },
      fetchedAt: 1000,
    };
    useStore.getState().setUsage(usage);
    expect(useStore.getState().usage).toEqual(usage);
    // A null poll result hides the bars (the feature is unavailable).
    useStore.getState().setUsage(null);
    expect(useStore.getState().usage).toBeNull();
  });

  it("applyFrame folds frames into a per-session view and dedups replays", () => {
    const { applyFrame } = useStore.getState();
    applyFrame(
      "s1",
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      }),
    );
    applyFrame(
      "s1",
      ev(2, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
      }),
    );
    expect(useStore.getState().viewFor("s1").liveText).toBe("Hi!");
    // replayed seq 2 must not double-append
    applyFrame(
      "s1",
      ev(2, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
      }),
    );
    expect(useStore.getState().viewFor("s1").liveText).toBe("Hi!");
    expect(useStore.getState().viewFor("s1").lastSeq).toBe(2);
  });

  it("keeps meta.awaiting in sync with the live view: a prompt raises it, a result clears it instantly", () => {
    const { applyFrame, setSessions } = useStore.getState();
    setSessions([meta]);
    const awaitingOf = () => useStore.getState().sessions.find((s) => s.id === "s1")?.awaiting;
    // A permission prompt arrives on the live wire → the rail must show "needs you" NOW, not 15s later.
    applyFrame("s1", {
      seq: 1,
      kind: "permission",
      payload: { requestId: "r1", kind: "hook_callback", toolName: "Bash" },
    });
    expect(awaitingOf()).toBe(true);
    // The turn ends (answered) → awaiting clears instantly so the badge/Stop button don't lag the poll.
    applyFrame("s1", { seq: 2, kind: "result", payload: { subtype: "success" } });
    expect(awaitingOf()).toBe(false);
  });

  it("mergeSessionMeta is SERVER-authoritative for awaiting (the poll can raise a prompt the view missed)", () => {
    // The live view owns the instant optimistic update (applyFrame syncAwaiting); the poll re-confirms and
    // can RAISE awaiting for a genuine prompt the WS hasn't delivered yet — so it must not be overridden.
    const { setSessions, setActive, mergeSessionMeta } = useStore.getState();
    setSessions([meta, { ...meta, id: "s2" }]);
    setActive("s1");
    mergeSessionMeta([
      { ...meta, awaiting: true },
      { ...meta, id: "s2", awaiting: true },
    ]);
    expect(useStore.getState().sessions.find((s) => s.id === "s1")?.awaiting).toBe(true);
    expect(useStore.getState().sessions.find((s) => s.id === "s2")?.awaiting).toBe(true);
  });

  it("a non-prompt frame never reallocates the sessions array (no needless rail re-render)", () => {
    const { applyFrame, setSessions } = useStore.getState();
    setSessions([meta]);
    const before = useStore.getState().sessions;
    applyFrame(
      "s1",
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      }),
    );
    expect(useStore.getState().sessions).toBe(before); // same reference — awaiting unchanged (false→false)
  });

  it("loadHistory preserves early live turns that raced in before history, deduping transcript overlap", () => {
    const { applyFrame, loadHistory } = useStore.getState();
    // Fresh open: two early WS frames land before the REST history resolves — one NEW (live early) and one
    // that DUPLICATES a transcript turn (old a). Both bump lastSeq past the history sinceSeq.
    applyFrame("s1", {
      seq: 51,
      kind: "event",
      payload: { type: "assistant", message: { content: [{ type: "text", text: "old a" }] } },
    });
    applyFrame("s1", {
      seq: 52,
      kind: "event",
      payload: { type: "assistant", message: { content: [{ type: "text", text: "live early" }] } },
    });
    expect(useStore.getState().viewFor("s1").lastSeq).toBe(52);

    const histFrames: ServerFrame[] = [
      {
        seq: 1,
        kind: "event",
        payload: { type: "user", uuid: "h1", message: { content: [{ type: "text", text: "old q" }] } },
      },
      {
        seq: 2,
        kind: "event",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "old a" }] } },
      },
    ];
    loadHistory("s1", histFrames, 50);

    const texts = useStore
      .getState()
      .viewFor("s1")
      .turns.filter((t) => t.kind === "assistant-text" || t.kind === "user")
      .map((t) => (t.kind === "assistant-text" ? t.text : "user"));
    // transcript [user, "old a"] + the NEW early live turn — "old a" not duplicated, "live early" not dropped.
    expect(texts).toEqual(["user", "old a", "live early"]);
  });

  it("loadHistory seeds a pending prompt from live so a chat reopened mid-prompt isn't stuck", () => {
    const { loadHistory } = useStore.getState();
    loadHistory("s1", [], 5, {
      turnActive: true,
      pendingPermission: { requestId: "r1", kind: "hook_callback", toolName: "Bash" },
    });
    const v = useStore.getState().viewFor("s1");
    expect(v.pendingPermission).toEqual({ requestId: "r1", kind: "hook_callback", toolName: "Bash" });
    expect(v.wireState).toBe("awaiting"); // shows the card + Stop, not a phantom "working"
  });

  it("appendUserMessage adds an optimistic user turn to the view", () => {
    useStore.getState().appendUserMessage("s1", [{ type: "text", text: "hi there" }]);
    const turns = useStore.getState().viewFor("s1").turns;
    expect(turns.at(-1)).toEqual({ kind: "user", blocks: [{ type: "text", text: "hi there" }] });
  });

  it("setSessions seeds a missing lastActiveAt from createdAt and keeps existing stamps", () => {
    useStore.setState({ lastActiveAt: { s2: 12345 } });
    const a: SessionMeta = { id: "s1", cwd: "/a", dangerouslySkip: false, status: "running", createdAt: 7 };
    const b: SessionMeta = { id: "s2", cwd: "/b", dangerouslySkip: false, status: "running", createdAt: 8 };
    useStore.getState().setSessions([a, b]);
    const { lastActiveAt } = useStore.getState();
    expect(lastActiveAt["s1"]).toBe(7); // seeded from createdAt
    expect(lastActiveAt["s2"]).toBe(12345); // pre-existing stamp preserved
  });

  it("setActive does NOT bump lastActiveAt — viewing a chat must not reorder the rail", () => {
    useStore.setState({ lastActiveAt: { s1: 5 } });
    useStore.getState().setActive("s1");
    expect(useStore.getState().activeSessionId).toBe("s1");
    // The stamp is untouched by selection — only send/receive moves a session up the rail.
    expect(useStore.getState().lastActiveAt["s1"]).toBe(5);
    // Clearing the selection touches nothing else.
    useStore.getState().setActive(undefined);
    expect(useStore.getState().activeSessionId).toBeUndefined();
    expect(useStore.getState().lastActiveAt["s1"]).toBe(5);
  });

  it("applyFrame bumps lastActiveAt for a user/assistant MESSAGE frame (real activity)", () => {
    const before = Date.now();
    useStore.getState().applyFrame("s1", ev(1, { type: "assistant", message: { content: [] } }));
    expect(useStore.getState().lastActiveAt["s1"]).toBeGreaterThanOrEqual(before);
  });

  it("applyFrame does NOT bump lastActiveAt for plumbing frames (stream delta / system)", () => {
    useStore.setState({ lastActiveAt: { s1: 5 } });
    useStore.getState().applyFrame("s1", ev(1, { type: "stream_event", event: { type: "x" } }));
    // A stream delta is not a new turn — it must not reorder the rail.
    expect(useStore.getState().lastActiveAt["s1"]).toBe(5);
  });

  it("appendUserMessage bumps lastActiveAt (the user just sent — optimistic activity)", () => {
    const before = Date.now();
    useStore.getState().appendUserMessage("s1", [{ type: "text", text: "hi" }]);
    expect(useStore.getState().lastActiveAt["s1"]).toBeGreaterThanOrEqual(before);
  });

  it("mergeSessionMeta merges meta + drops vanished sessions, keeping the live view intact", () => {
    // Two live sessions, s1 with a streamed view; s1 also has a higher local optimistic stamp.
    useStore.setState({ lastActiveAt: { s1: 999, s2: 5 } });
    useStore.getState().applyFrame(
      "s1",
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      }),
    );
    const s1: SessionMeta = {
      id: "s1",
      cwd: "/a",
      dangerouslySkip: false,
      status: "running",
      createdAt: 1,
      awaiting: true,
      lastActivityAt: 50,
    };
    // A poll returns ONLY s1 (s2 vanished/closed) with fresh awaiting + a server lastActivityAt below
    // the local stamp.
    useStore.getState().mergeSessionMeta([s1]);
    const st = useStore.getState();
    // s2 (no longer returned) is dropped from the list and its stamp pruned.
    expect(st.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(st.lastActiveAt["s2"]).toBeUndefined();
    // s1's awaiting flag refreshed from the poll; its live view (streamed "Hi") is untouched.
    expect(st.sessions[0]!.awaiting).toBe(true);
    expect(st.viewFor("s1").liveText).toBe("Hi");
    // The local optimistic stamp (999) wins over the lower server lastActivityAt (50).
    expect(st.lastActiveAt["s1"]).toBe(999);
  });

  it("addSession re-adds a removed session (idempotent) — used to undo a failed close", () => {
    const s: SessionMeta = {
      id: "s1",
      cwd: "/p",
      dangerouslySkip: false,
      status: "running",
      createdAt: 1,
      lastActivityAt: 42,
    };
    useStore.getState().addSession(s);
    expect(useStore.getState().sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(useStore.getState().lastActiveAt["s1"]).toBe(42);
    // Re-adding the same id is a no-op (no duplicate row).
    useStore.getState().addSession(s);
    expect(useStore.getState().sessions).toHaveLength(1);
  });

  it("removeSession drops the session, its view, and its activity stamp", () => {
    useStore.setState({ sessions: [meta], lastActiveAt: { s1: 5 } });
    useStore.getState().applyFrame("s1", ev(1, { type: "stream_event", event: { type: "x" } }));
    useStore.getState().removeSession("s1");
    const s = useStore.getState();
    expect(s.sessions).toEqual([]);
    expect(s.lastActiveAt["s1"]).toBeUndefined();
    expect(s.views["s1"]).toBeUndefined();
  });

  it("loadHistory renders the transcript (user + assistant, in order) and sets lastSeq = sinceSeq", () => {
    // Display frames carry 1-based DISPLAY seqs; the buffer's max seq is 7 (sinceSeq). lastSeq must be
    // set to sinceSeq (the WS seq space), NOT the display frames' seqs, so live frames dedup correctly.
    const history: ServerFrame[] = [
      ev(1, { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "my question" }] } }),
      ev(2, { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "my answer" }] } }),
    ];
    useStore.getState().loadHistory("s1", history, 7);
    const view = useStore.getState().viewFor("s1");
    // The user's OWN message survives the reopen, correctly attributed, in order before the assistant's.
    expect(view.turns).toEqual([
      { kind: "user", blocks: [{ type: "text", text: "my question" }], checkpointId: "u1" },
      { kind: "assistant-text", text: "my answer" },
    ]);
    // lastSeq is the server's sinceSeq, decoupled from the display seqs (1, 2).
    expect(view.lastSeq).toBe(7);
  });

  it("loadHistory resets the wire to idle when the transcript ends mid-tool (no persisted result frame)", () => {
    // The transcript keeps only user/assistant lines, so the `result` event that returns the wire to idle
    // is never persisted. A reopen whose last assistant turn was a tool_use must NOT get stuck showing
    // "Running tool" + a Stop button while nothing is actually running.
    const history: ServerFrame[] = [
      ev(1, { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "do it" }] } }),
      ev(2, {
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      }),
    ];
    useStore.getState().loadHistory("s1", history, 9);
    expect(useStore.getState().viewFor("s1").wireState).toBe("idle");

    // ...but a genuinely live tool_use AFTER the reopen still drives the wire to running-tool.
    useStore.getState().applyFrame(
      "s1",
      ev(10, {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }] },
      }),
    );
    expect(useStore.getState().viewFor("s1").wireState).toBe("running-tool");
  });

  it("loadHistory SEEDS wire + meter from the server live tail (switch to a chat mid-turn)", () => {
    // A switched-to chat whose turn is still in flight must show "working" (not a wrong idle) and its
    // context meter immediately — the transcript has no result/stream frame, so the server's `live` seeds it.
    const history: ServerFrame[] = [
      ev(1, { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "go" }] } }),
    ];
    useStore.getState().loadHistory("s1", history, 9, {
      turnActive: true,
      usage: { contextTokens: 42000, contextWindow: 200000 },
    });
    const v = useStore.getState().viewFor("s1");
    expect(v.wireState).toBe("running-tool");
    expect(v.usage).toEqual({ contextTokens: 42000, contextWindow: 200000 });
  });

  it("setCompacting flags the session; a result frame clears it", () => {
    useStore.getState().setCompacting("s1", true);
    expect(useStore.getState().viewFor("s1").compacting).toBe(true);
    // The /compact turn's result clears the indicator.
    useStore.getState().applyFrame("s1", { seq: 1, kind: "result", payload: { type: "result", raw: {} } });
    expect(useStore.getState().viewFor("s1").compacting).toBe(false);
  });

  it("loadHistory seeds idle wire when the server says no turn is active (and still seeds usage)", () => {
    const history: ServerFrame[] = [
      ev(1, { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "go" }] } }),
    ];
    useStore.getState().loadHistory("s1", history, 9, { turnActive: false, usage: { contextTokens: 5000 } });
    const v = useStore.getState().viewFor("s1");
    expect(v.wireState).toBe("idle");
    expect(v.usage).toEqual({ contextTokens: 5000 });
  });

  it("after loadHistory, a live frame (seq > sinceSeq) appends and a frame (seq <= sinceSeq) is a no-op", () => {
    const history: ServerFrame[] = [
      ev(1, { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } }),
    ];
    useStore.getState().loadHistory("s1", history, 5);
    expect(useStore.getState().viewFor("s1").turns).toHaveLength(1);

    // A frame at/under sinceSeq (already represented by the transcript / replayed buffer) is dropped.
    useStore
      .getState()
      .applyFrame("s1", ev(5, { type: "assistant", message: { content: [{ type: "text", text: "stale" }] } }));
    expect(useStore.getState().viewFor("s1").turns).toHaveLength(1);

    // A genuinely NEW live frame (seq > sinceSeq) appends once, no duplication.
    useStore
      .getState()
      .applyFrame("s1", ev(6, { type: "assistant", message: { content: [{ type: "text", text: "live reply" }] } }));
    const turns = useStore.getState().viewFor("s1").turns;
    expect(turns).toHaveLength(2);
    expect(turns.at(-1)).toEqual({ kind: "assistant-text", text: "live reply" });
    expect(useStore.getState().viewFor("s1").lastSeq).toBe(6);
  });

  it("loadHistory preserves live state that already arrived (seq > sinceSeq) instead of clobbering it", () => {
    // Race: a live stream delta arrives BEFORE the transcript history resolves. loadHistory must not
    // wipe it — the live frame's seq (3) is past sinceSeq (2), so its liveText/lastSeq are carried over.
    useStore.getState().applyFrame(
      "s1",
      ev(3, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streaming" } },
      }),
    );
    const history: ServerFrame[] = [
      ev(1, { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "q" }] } }),
    ];
    useStore.getState().loadHistory("s1", history, 2);
    const view = useStore.getState().viewFor("s1");
    expect(view.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "q" }], checkpointId: "u1" }]);
    expect(view.liveText).toBe("streaming"); // live state preserved
    expect(view.lastSeq).toBe(3); // the higher live seq wins
  });

  it("resetSession clears a session view; viewFor returns an empty view for unknown ids", () => {
    const { applyFrame, resetSession, viewFor } = useStore.getState();
    applyFrame(
      "s1",
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      }),
    );
    expect(viewFor("s1").liveText).toBe("x");
    resetSession("s1");
    expect(useStore.getState().viewFor("s1").liveText).toBe("");
    expect(useStore.getState().viewFor("unknown").lastSeq).toBe(0);
  });
});
