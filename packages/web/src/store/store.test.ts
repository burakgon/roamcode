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
      ev(1, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }),
    );
    const s1: SessionMeta = { id: "s1", cwd: "/a", dangerouslySkip: false, status: "running", createdAt: 1, awaiting: true, lastActivityAt: 50 };
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
    const s: SessionMeta = { id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1, lastActivityAt: 42 };
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
