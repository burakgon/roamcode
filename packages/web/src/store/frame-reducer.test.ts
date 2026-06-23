import { describe, expect, it } from "vitest";
import { emptyView, reduceFrame } from "./frame-reducer";
import type { ServerFrame } from "../types/server";

function ev(seq: number, payload: unknown): ServerFrame { return { seq, kind: "event", payload }; }

describe("reduceFrame", () => {
  it("accumulates streamed text_delta into liveText and sets wireState=streaming", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } }));
    v = reduceFrame(v, ev(2, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } }));
    expect(v.liveText).toBe("Hello");
    expect(v.wireState).toBe("streaming");
    expect(v.lastSeq).toBe(2);
  });

  it("commits a final assistant message into a turn and clears liveText", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } }));
    v = reduceFrame(v, ev(2, { type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } }));
    expect(v.liveText).toBe("");
    expect(v.turns.at(-1)).toEqual({ kind: "assistant-text", text: "Hi there" });
  });

  it("captures a tool_use turn and sets wireState=running-tool", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/a" } }] } }));
    expect(v.turns.at(-1)).toEqual({ kind: "tool-use", id: "tu1", name: "Write", input: { file_path: "/a" } });
    expect(v.wireState).toBe("running-tool");
  });

  it("records a tool_result from a user event", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "done" }] } }));
    expect(v.turns.at(-1)).toEqual({ kind: "tool-result", toolUseId: "tu1", content: "done" });
  });

  it("sets pendingPermission on a permission frame (wireState=awaiting) and clears it on result", () => {
    let v = emptyView();
    v = reduceFrame(v, { seq: 1, kind: "permission", payload: { requestId: "r1", kind: "hook_callback", toolName: "Write" } });
    expect(v.pendingPermission?.requestId).toBe("r1");
    expect(v.wireState).toBe("awaiting");
    v = reduceFrame(v, { seq: 2, kind: "result", payload: { type: "result", result: "ok", permissionDenials: [], raw: {} } });
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

  it("ignores a replayed frame at or below lastSeq (delta-replay dedup)", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } } }));
    v = reduceFrame(v, ev(2, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } } }));
    expect(v.liveText).toBe("AB");
    // a duplicate replay of seq 2 must NOT re-append
    v = reduceFrame(v, ev(2, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } } }));
    expect(v.liveText).toBe("AB");
    expect(v.lastSeq).toBe(2);
    // a fresh frame still applies
    v = reduceFrame(v, ev(3, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "C" } } }));
    expect(v.liveText).toBe("ABC");
    expect(v.lastSeq).toBe(3);
  });
});
