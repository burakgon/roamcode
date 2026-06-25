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
    expect(v.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "fix the bug" }], checkpointId: "u1" }]);
  });

  it("renders a user TEXT event with text blocks as a user turn", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, { type: "user", message: { content: [{ type: "text", text: "do the thing" }] }, uuid: "u2" }),
    );
    expect(v.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "do the thing" }], checkpointId: "u2" }]);
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
      { kind: "user", blocks: [{ type: "text", text: "and then" }], checkpointId: "u3" },
      { kind: "tool-result", toolUseId: "tu9", content: "ok" },
    ]);
  });

  it("reconciles the optimistic bubble with the live --replay-user-messages echo: one bubble, gains checkpointId", () => {
    // The live flow with --replay-user-messages: the sender's own message is appended optimistically
    // (store-side, no checkpointId), THEN claude re-emits it live as a `user` text event carrying its
    // uuid. The reducer must NOT draw a second bubble — it stamps the uuid (checkpointId) onto the
    // existing optimistic turn so the message shows once AND becomes rewindable.
    let v = emptyView();
    v = { ...v, turns: [{ kind: "user", blocks: [{ type: "text", text: "hi" }] }] }; // optimistic (store-side)
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "hi" }, uuid: "cp-1" }));
    const userTurns = v.turns.filter((t) => t.kind === "user");
    expect(userTurns).toHaveLength(1); // one bubble, not two
    expect(userTurns[0]).toEqual({ kind: "user", blocks: [{ type: "text", text: "hi" }], checkpointId: "cp-1" });
  });

  it("an echo with no matching optimistic bubble (resume replay) appends a user turn carrying the checkpointId", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "fix the bug" }, uuid: "cp-2" }));
    expect(v.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "fix the bug" }], checkpointId: "cp-2" }]);
  });

  it("only reconciles UNRECLAIMED optimistic bubbles: two identical sends keep two distinct bubbles+checkpoints", () => {
    let v = emptyView();
    // Two optimistic sends of the same text.
    v = {
      ...v,
      turns: [
        { kind: "user", blocks: [{ type: "text", text: "ping" }] },
        { kind: "user", blocks: [{ type: "text", text: "ping" }] },
      ],
    };
    // Two echoes (distinct uuids) must stamp the two distinct bubbles, not collapse them.
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "ping" }, uuid: "cp-a" }));
    v = reduceFrame(v, ev(2, { type: "user", message: { content: "ping" }, uuid: "cp-b" }));
    const userTurns = v.turns.filter((t): t is Extract<typeof t, { kind: "user" }> => t.kind === "user");
    expect(userTurns).toHaveLength(2);
    const ids = userTurns.map((t) => t.checkpointId).sort();
    expect(ids).toEqual(["cp-a", "cp-b"]);
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

  it("a user-interrupted (aborted) result is STOPPED not error: wireState=idle, turn marked stopped", () => {
    let v = emptyView();
    // Mid-stream, then the interrupt's aborted result lands.
    v = reduceFrame(
      v,
      ev(1, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Work" } },
      }),
    );
    expect(v.wireState).toBe("streaming");
    v = reduceFrame(v, {
      seq: 2,
      kind: "result",
      payload: {
        type: "result",
        subtype: "error_during_execution",
        isError: true,
        terminalReason: "aborted_streaming",
        result: "Interrupted by user",
        raw: {},
      },
    });
    // Calm STOP, not a red error: wire returns to idle so the user can type the next message.
    expect(v.wireState).toBe("idle");
    expect(v.liveText).toBe("");
    expect(v.turns.at(-1)).toMatchObject({ kind: "result", stopped: true });
  });

  it("an aborted result identified by subtype alone (no terminal_reason) is still stopped", () => {
    let v = emptyView();
    v = reduceFrame(v, {
      seq: 1,
      kind: "result",
      payload: { type: "result", subtype: "error_during_execution", isError: true, raw: {} },
    });
    expect(v.wireState).toBe("idle");
    expect(v.turns.at(-1)).toMatchObject({ kind: "result", stopped: true });
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

  it("rewound (code): appends a marker but does NOT truncate the thread (files only)", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "do A" }, uuid: "cp-1" }));
    v = reduceFrame(v, ev(2, { type: "assistant", message: { content: [{ type: "text", text: "did A" }] } }));
    v = reduceFrame(v, ev(3, { type: "user", message: { content: "do B" }, uuid: "cp-2" }));
    v = reduceFrame(v, { seq: 4, kind: "rewound", payload: { checkpointId: "cp-1", mode: "code", ok: true } });
    // Both user turns + the assistant turn remain; a rewound marker is appended last.
    expect(v.turns.filter((t) => t.kind === "user")).toHaveLength(2);
    expect(v.turns.at(-1)).toEqual({ kind: "rewound", checkpointId: "cp-1", mode: "code", ok: true });
  });

  it("rewound (conversation): truncates the thread to the checkpoint, then appends the marker", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "do A" }, uuid: "cp-1" }));
    v = reduceFrame(v, ev(2, { type: "assistant", message: { content: [{ type: "text", text: "did A" }] } }));
    v = reduceFrame(v, ev(3, { type: "user", message: { content: "do B" }, uuid: "cp-2" }));
    v = reduceFrame(v, ev(4, { type: "assistant", message: { content: [{ type: "text", text: "did B" }] } }));
    v = reduceFrame(v, { seq: 5, kind: "rewound", payload: { checkpointId: "cp-1", mode: "conversation", ok: true } });
    // Everything AFTER the cp-1 user turn is dropped (keeping the checkpoint turn), then the marker.
    expect(v.turns).toEqual([
      { kind: "user", blocks: [{ type: "text", text: "do A" }], checkpointId: "cp-1" },
      { kind: "rewound", checkpointId: "cp-1", mode: "conversation", ok: true },
    ]);
    expect(v.wireState).toBe("idle");
  });

  it("rewound (failed): shows the marker with an error and never truncates", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "do A" }, uuid: "cp-1" }));
    v = reduceFrame(v, ev(2, { type: "assistant", message: { content: [{ type: "text", text: "did A" }] } }));
    v = reduceFrame(v, {
      seq: 3,
      kind: "rewound",
      payload: { checkpointId: "cp-1", mode: "both", ok: false, error: "File rewinding is not enabled." },
    });
    // The assistant turn is untouched; the marker carries the error.
    expect(v.turns.some((t) => t.kind === "assistant-text")).toBe(true);
    expect(v.turns.at(-1)).toMatchObject({ kind: "rewound", ok: false, error: "File rewinding is not enabled." });
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
