import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./store";
import type { ServerFrame, SessionMeta } from "../types/server";

function ev(seq: number, payload: unknown): ServerFrame {
  return { seq, kind: "event", payload };
}

const meta: SessionMeta = { id: "s1", cwd: "/p", dangerouslySkip: false, status: "running", createdAt: 1 };

beforeEach(() => {
  useStore.setState({ token: undefined, sessions: [], activeSessionId: undefined, views: {} });
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
