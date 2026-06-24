import { describe, expect, it } from "vitest";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { ServerFrame } from "../types/server";

function ev(seq: number, payload: unknown): ServerFrame {
  return { seq, kind: "event", payload };
}

describe("reduceFrame", () => {
  it("accumulates streamed text_delta into liveText and sets wireState=streaming", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      }),
    );
    v = reduceFrame(
      v,
      ev(2, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      }),
    );
    expect(v.liveText).toBe("Hello");
    expect(v.wireState).toBe("streaming");
    expect(v.lastSeq).toBe(2);
  });

  it("commits a final assistant message into a turn and clears liveText", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      }),
    );
    v = reduceFrame(v, ev(2, { type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } }));
    expect(v.liveText).toBe("");
    expect(v.turns.at(-1)).toEqual({ kind: "assistant-text", text: "Hi there" });
  });

  it("captures a tool_use turn and sets wireState=running-tool", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a" } }] },
      }),
    );
    expect(v.turns.at(-1)).toEqual({ kind: "tool-use", id: "tu1", name: "Write", input: { file_path: "/a" } });
    expect(v.wireState).toBe("running-tool");
  });

  it("records a tool_result from a user event", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "done" }] } }),
    );
    expect(v.turns.at(-1)).toEqual({ kind: "tool-result", toolUseId: "tu1", content: "done" });
  });

  it("renders a user TEXT event (string content) as a user turn — needed for resume replay", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "fix the bug" }, uuid: "u1" }));
    expect(v.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "fix the bug" }] }]);
  });

  it("renders a user TEXT event with text blocks as a user turn", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, { type: "user", message: { content: [{ type: "text", text: "do the thing" }] }, uuid: "u2" }),
    );
    expect(v.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "do the thing" }] }]);
  });

  it("dedupes a user text event by uuid — a duplicate delivery does NOT draw a second bubble", () => {
    let v = emptyView();
    // First delivery (e.g. transcript replay) → one user turn.
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "hello" }, uuid: "dup" }));
    // A second frame carrying the SAME uuid (overlap/dup replay) must be a no-op for the text turn.
    v = reduceFrame(v, ev(2, { type: "user", message: { content: "hello" }, uuid: "dup" }));
    const userTurns = v.turns.filter((t) => t.kind === "user");
    expect(userTurns).toHaveLength(1);
  });

  it("a user event with BOTH text and a tool_result yields a user turn AND a tool-result turn", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, {
        type: "user",
        uuid: "u3",
        message: {
          content: [
            { type: "text", text: "and then" },
            { type: "tool_result", tool_use_id: "tu9", content: "ok" },
          ],
        },
      }),
    );
    expect(v.turns).toEqual([
      { kind: "user", blocks: [{ type: "text", text: "and then" }] },
      { kind: "tool-result", toolUseId: "tu9", content: "ok" },
    ]);
  });

  it("does not duplicate a live user bubble: optimistic append + later assistant reply, no echoed user-text event", () => {
    // Mirrors the live flow: the sender's own message is appended optimistically (the store does this,
    // not the reducer), then claude streams a reply. claude never re-emits the user TEXT as a `user`
    // event live, so the reducer never re-adds it. Prove the reducer adds no extra user turn here.
    let v = emptyView();
    v = { ...v, turns: [{ kind: "user", blocks: [{ type: "text", text: "hi" }] }] }; // optimistic (store-side)
    v = reduceFrame(v, ev(1, { type: "assistant", message: { content: [{ type: "text", text: "hello!" }] } }));
    // a live `user` event only ever carries a tool_result (not the typed text) — that still works:
    v = reduceFrame(
      v,
      ev(2, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] } }),
    );
    const userTurns = v.turns.filter((t) => t.kind === "user");
    expect(userTurns).toHaveLength(1); // still just the one optimistic bubble — no duplicate
  });

  it("sets pendingPermission on a permission frame (wireState=awaiting) and clears it on result", () => {
    let v = emptyView();
    v = reduceFrame(v, {
      seq: 1,
      kind: "permission",
      payload: { requestId: "r1", kind: "hook_callback", toolName: "Write" },
    });
    expect(v.pendingPermission?.requestId).toBe("r1");
    expect(v.wireState).toBe("awaiting");
    v = reduceFrame(v, {
      seq: 2,
      kind: "result",
      payload: { type: "result", result: "ok", permissionDenials: [], raw: {} },
    });
    expect(v.pendingPermission).toBeUndefined();
    expect(v.wireState).toBe("success");
    expect(v.turns.at(-1)).toMatchObject({ kind: "result", result: "ok" });
  });

  it("sets wireState=error on an errored result and collects diagnostics", () => {
    let v = emptyView();
    v = reduceFrame(v, { seq: 1, kind: "diagnostic", payload: { source: "stderr", message: "auth expired" } });
    expect(v.diagnostics).toHaveLength(1);
    v = reduceFrame(v, { seq: 2, kind: "result", payload: { type: "result", isError: true, result: "boom", raw: {} } });
    expect(v.wireState).toBe("error");
  });

  it("a question frame sets pendingQuestion and awaiting wireState", () => {
    const frame: ServerFrame = {
      seq: 1,
      kind: "question",
      payload: {
        requestId: "rq",
        toolInput: {},
        questions: [{ question: "Q", multiSelect: false, options: [{ label: "A" }] }],
      },
    };
    const v = reduceFrame(emptyView(), frame);
    expect(v.pendingQuestion?.requestId).toBe("rq");
    expect(v.wireState).toBe("awaiting");
  });

  it("threads askId through to pendingQuestion (ask_user routing key)", () => {
    const frame: ServerFrame = {
      seq: 1,
      kind: "question",
      payload: {
        requestId: "ask-7",
        askId: "ask-7",
        toolInput: { questions: [] },
        questions: [{ question: "Q", multiSelect: false, options: [{ label: "A" }] }],
      },
    };
    const v = reduceFrame(emptyView(), frame);
    expect(v.pendingQuestion?.askId).toBe("ask-7");
    expect(v.pendingQuestion?.requestId).toBe("ask-7");
  });

  it("a result clears a pending question", () => {
    let v = reduceFrame(emptyView(), {
      seq: 1,
      kind: "question",
      payload: { requestId: "rq", toolInput: {}, questions: [] },
    });
    v = reduceFrame(v, { seq: 2, kind: "result", payload: { type: "result", result: "done", raw: {} } });
    expect(v.pendingQuestion).toBeUndefined();
  });

  it("turns an attachment frame into an attachment turn (Claude sent a file)", () => {
    const frame: ServerFrame = {
      seq: 1,
      kind: "attachment",
      payload: { id: "att-1", path: "/r/a.png", name: "a.png", caption: "here", isImage: true },
    };
    const v = reduceFrame(emptyView(), frame);
    expect(v.turns.at(-1)).toEqual({
      kind: "attachment",
      id: "att-1",
      path: "/r/a.png",
      name: "a.png",
      caption: "here",
      isImage: true,
    });
  });

  it("ignores a replayed frame at or below lastSeq (delta-replay dedup)", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } },
      }),
    );
    v = reduceFrame(
      v,
      ev(2, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } },
      }),
    );
    expect(v.liveText).toBe("AB");
    // a duplicate replay of seq 2 must NOT re-append
    v = reduceFrame(
      v,
      ev(2, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } },
      }),
    );
    expect(v.liveText).toBe("AB");
    expect(v.lastSeq).toBe(2);
    // a fresh frame still applies
    v = reduceFrame(
      v,
      ev(3, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "C" } },
      }),
    );
    expect(v.liveText).toBe("ABC");
    expect(v.lastSeq).toBe(3);
  });
});
