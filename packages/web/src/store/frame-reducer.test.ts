import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyView, reduceFrame, subagentResultText } from "./frame-reducer";
import type { SessionView, SubagentThread, TurnItem } from "./frame-reducer";
import type { ServerFrame } from "../types/server";

function ev(seq: number, payload: unknown): ServerFrame {
  return { seq, kind: "event", payload };
}

// --- fixture-driven subagent tests --------------------------------------------------------------
// The web bundle never imports the Node `@remote-coder/protocol` package, so the test mirrors what
// `parse.ts` lifts (verified independently in packages/protocol/test/parse.test.ts): raw claude line →
// camelCase InboundEvent → reducer. We drive the REAL captured fixtures through that pipeline.

type AnyRec = Record<string, unknown>;
const g = (o: AnyRec, k: string): unknown => o[k];

/** Mirror of parse.ts field-lifting for the event types the reducer reads. */
function toPayload(o: AnyRec): AnyRec | null {
  const t = g(o, "type");
  if (t === "system") {
    const subtype = (g(o, "subtype") as string) ?? "";
    const base: AnyRec = { type: "system", subtype, sessionId: g(o, "session_id"), agents: g(o, "agents") };
    if (typeof subtype === "string" && subtype.startsWith("task_")) {
      const usage = g(o, "usage") as AnyRec | undefined;
      const patch = g(o, "patch") as AnyRec | undefined;
      base.task = {
        taskId: g(o, "task_id"),
        toolUseId: g(o, "tool_use_id"),
        subagentType: g(o, "subagent_type"),
        description: g(o, "description"),
        prompt: g(o, "prompt"),
        status: g(o, "status"),
        summary: g(o, "summary"),
        lastToolName: g(o, "last_tool_name"),
        ...(patch ? { patch: { status: patch.status, endTime: patch.end_time } } : {}),
        ...(usage
          ? { usage: { totalTokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms } }
          : {}),
      };
    }
    return base;
  }
  if (t === "assistant" || t === "user") {
    return {
      type: t,
      message: g(o, "message"),
      sessionId: g(o, "session_id"),
      parentToolUseId: (g(o, "parent_tool_use_id") as string | null) ?? undefined,
      uuid: g(o, "uuid"),
    };
  }
  if (t === "stream_event") {
    return {
      type: "stream_event",
      event: g(o, "event"),
      parentToolUseId: (g(o, "parent_tool_use_id") as string | null) ?? undefined,
    };
  }
  // result/control_request/rate_limit/etc. — the reducer's event branch ignores these (result is a
  // separate frame kind in the live pipeline). Pass the type through so the fold is faithful.
  return { type: t };
}

/** Locate a protocol fixture from the test's cwd (repo root for `pnpm test`, packages/web otherwise). */
function fixturePath(name: string): string {
  const candidates = [
    resolve(process.cwd(), "packages/protocol/fixtures", `${name}.jsonl`),
    resolve(process.cwd(), "../protocol/fixtures", `${name}.jsonl`),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`fixture ${name} not found (cwd=${process.cwd()})`);
  return found;
}

function foldFixture(name: string): SessionView {
  const text = readFileSync(fixturePath(name), "utf8");
  let view = emptyView();
  let seq = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const payload = toPayload(JSON.parse(line) as AnyRec);
    if (!payload) continue;
    view = reduceFrame(view, ev(++seq, payload));
  }
  return view;
}

/** The subagent-related turns that leaked into the MAIN thread, by kind. */
function mainKinds(view: SessionView): string[] {
  return view.turns.map((t) => t.kind);
}
function sub(view: SessionView, id: string): SubagentThread {
  const s = view.subagents[id];
  if (!s) throw new Error(`no subagent ${id}; have ${Object.keys(view.subagents).join(",")}`);
  return s;
}
function turnKinds(turns: TurnItem[]): string[] {
  return turns.map((t) => t.kind);
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

  it("does NOT render an injected isMeta user message (skill content / system-reminder) as a YOU turn", () => {
    let v = emptyView();
    v = reduceFrame(
      v,
      ev(1, {
        type: "user",
        message: {
          content: [{ type: "text", text: "Base directory for this skill: /x\n# Systematic Debugging" }],
        },
        uuid: "m1",
        raw: { isMeta: true },
      }),
    );
    expect(v.turns.filter((t) => t.kind === "user")).toHaveLength(0);
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

  it("reconciling a QUEUED optimistic bubble drops the queued flag (it's now being processed, renders inline)", () => {
    let v = emptyView();
    // A message sent WHILE a turn was running is appended optimistically with queued:true.
    v = { ...v, turns: [{ kind: "user", blocks: [{ type: "text", text: "next" }], queued: true }] };
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "next" }, uuid: "cp-2" }));
    const userTurns = v.turns.filter((t) => t.kind === "user");
    expect(userTurns).toHaveLength(1);
    // No `queued` field on the reconciled turn → MessageList renders it inline, not below the live stream.
    expect(userTurns[0]).toEqual({ kind: "user", blocks: [{ type: "text", text: "next" }], checkpointId: "cp-2" });
  });

  it("an echo with no matching optimistic bubble (resume replay) appends a user turn carrying the checkpointId", () => {
    let v = emptyView();
    v = reduceFrame(v, ev(1, { type: "user", message: { content: "fix the bug" }, uuid: "cp-2" }));
    expect(v.turns).toEqual([{ kind: "user", blocks: [{ type: "text", text: "fix the bug" }], checkpointId: "cp-2" }]);
  });

  it("folds an ask_user MCP call (transcript reopen) into ONE asked-question turn with the answer", () => {
    let v = emptyView();
    // The model calls mcp__remote-coder__ask_user (recorded in the transcript as a tool_use)...
    v = reduceFrame(
      v,
      ev(1, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "q1",
              name: "mcp__remote-coder__ask_user",
              input: { questions: [{ header: "Resim", question: "Ne yapmak istersin?", options: [{ label: "A" }] }] },
            },
          ],
        },
      }),
    );
    // ...and the answer comes back as the paired tool_result.
    v = reduceFrame(
      v,
      ev(2, {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "User answered (no selection)." }] },
      }),
    );
    // ONE clean Q&A record — NOT a raw tool-use + tool-result pair.
    expect(v.turns).toHaveLength(1);
    const t = v.turns[0]!;
    expect(t.kind).toBe("asked-question");
    if (t.kind === "asked-question") {
      expect(t.questions).toEqual([{ header: "Resim", question: "Ne yapmak istersin?" }]);
      expect(t.answer).toBe("User answered (no selection).");
    }
    expect(v.turns.some((x) => x.kind === "tool-use" || x.kind === "tool-result")).toBe(false);
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

  it("a `resolve` frame clears a matching pending question (answered — never re-shown on reconnect)", () => {
    let v = reduceFrame(emptyView(), {
      seq: 1,
      kind: "question",
      payload: { requestId: "ask-9", askId: "ask-9", toolInput: {}, questions: [] },
    });
    expect(v.pendingQuestion?.requestId).toBe("ask-9");
    v = reduceFrame(v, { seq: 2, kind: "resolve", payload: { requestId: "ask-9" } });
    expect(v.pendingQuestion).toBeUndefined();
    // Was "awaiting"; once the only prompt is resolved the agent resumes → off the loud awaiting state.
    expect(v.wireState).toBe("thinking");
  });

  it("a `resolve` for a DIFFERENT requestId leaves the pending question intact", () => {
    let v = reduceFrame(emptyView(), {
      seq: 1,
      kind: "question",
      payload: { requestId: "ask-9", toolInput: {}, questions: [] },
    });
    v = reduceFrame(v, { seq: 2, kind: "resolve", payload: { requestId: "someone-else" } });
    expect(v.pendingQuestion?.requestId).toBe("ask-9");
  });

  it("a `resolve` frame clears a matching pending permission", () => {
    let v = reduceFrame(emptyView(), {
      seq: 1,
      kind: "permission",
      payload: { requestId: "perm-1", toolName: "Bash" },
    });
    expect(v.pendingPermission?.requestId).toBe("perm-1");
    v = reduceFrame(v, { seq: 2, kind: "resolve", payload: { requestId: "perm-1" } });
    expect(v.pendingPermission).toBeUndefined();
  });

  it("a system `init` (process start/resume) resets a stale 'working' wire to idle (no phantom 'running')", () => {
    // A transcript that ended MID-turn leaves the wire at "running-tool" (a tool_use with no result).
    let v = reduceFrame(
      emptyView(),
      ev(1, { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
    );
    expect(v.wireState).toBe("running-tool");
    v.liveText = "partial…";
    // The resumed/reconnected process emits `system init` → no active turn → idle (NOT stuck "working").
    v = reduceFrame(v, ev(2, { type: "system", subtype: "init" }));
    expect(v.wireState).toBe("idle");
    expect(v.liveText).toBe("");
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

describe("subagents — real captured fixtures (claude v2.1.191)", () => {
  it("subagent-simple: one general-purpose subagent, reply-only, completed with usage + result", () => {
    const v = foldFixture("subagent-simple");
    expect(v.subagentOrder).toHaveLength(1);
    const id = v.subagentOrder[0]!;
    const s = sub(v, id);
    expect(s.type).toBe("general-purpose");
    expect(s.status).toBe("completed");
    expect(s.description).toBe("Reply with three words");
    // Its prompt turn routed into the thread; no tool calls.
    expect(turnKinds(s.turns)).toEqual(["user"]);
    // Usage parsed from the <usage> trailer (subagent_tokens/tool_uses/duration_ms).
    expect(s.usage).toEqual({ tokens: 10615, toolUses: 0, durationMs: 1912 });
    expect(subagentResultText(s.result?.content)).toBe("red green blue");
    // Main chat: ONE subagent-ref anchor, no tool-use/tool-result leaked.
    expect(mainKinds(v).filter((k) => k === "subagent-ref")).toHaveLength(1);
    expect(mainKinds(v)).not.toContain("tool-use");
    expect(mainKinds(v)).not.toContain("tool-result");
  });

  it("subagent-turn: a tool-using subagent — Bash use+result routed into its thread, nothing leaks to main", () => {
    const v = foldFixture("subagent-turn");
    expect(v.subagentOrder).toHaveLength(1);
    const id = v.subagentOrder[0]!;
    const s = sub(v, id);
    expect(s.type).toBe("general-purpose");
    expect(s.status).toBe("completed");
    expect(s.parentId).toBeUndefined();
    // The subagent's OWN turns: its prompt, its Bash tool_use, and the Bash tool_result.
    expect(turnKinds(s.turns)).toEqual(["user", "tool-use", "tool-result"]);
    const toolUse = s.turns.find((t) => t.kind === "tool-use");
    expect(toolUse).toMatchObject({ kind: "tool-use", name: "Bash" });
    const toolResult = s.turns.find((t) => t.kind === "tool-result");
    expect(toolResult).toMatchObject({ kind: "tool-result", content: "hello-from-subagent" });
    // Live activity label came from task_progress.
    expect(s.activity).toBe("Running Echo a test string");
    // Usage: the result <usage> trailer wins over the earlier task_notification usage.
    expect(s.usage).toEqual({ tokens: 11401, toolUses: 1, durationMs: 4112 });
    expect(subagentResultText(s.result?.content)).toBe("The command output was hello-from-subagent.");
    expect(s.result?.isError).toBe(false);
    // MAIN thread stays clean: only the user prompt, the subagent-ref anchor, and the summary prose.
    expect(mainKinds(v)).toEqual(["user", "subagent-ref", "assistant-text"]);
    const ref = v.turns.find((t) => t.kind === "subagent-ref");
    expect(ref).toEqual({ kind: "subagent-ref", id });
  });

  it("subagent-parallel: TWO concurrent subagents, interleaved messages routed strictly by parent", () => {
    const v = foldFixture("subagent-parallel");
    expect(v.subagentOrder).toHaveLength(2);
    const [aId, bId] = v.subagentOrder as [string, string];
    const a = sub(v, aId);
    const b = sub(v, bId);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect(a.parentId).toBeUndefined();
    expect(b.parentId).toBeUndefined();
    // Despite interleaving, each subagent's Bash result landed in ITS OWN thread.
    const aResult = a.turns.find((t) => t.kind === "tool-result");
    const bResult = b.turns.find((t) => t.kind === "tool-result");
    expect(aResult).toMatchObject({ content: "AAA-from-one" });
    expect(bResult).toMatchObject({ content: "BBB-from-two" });
    expect(subagentResultText(a.result?.content)).toContain("AAA-from-one");
    expect(subagentResultText(b.result?.content)).toContain("BBB-from-two");
    // Main chat: exactly TWO subagent-ref anchors, no leaked tool plumbing.
    expect(mainKinds(v).filter((k) => k === "subagent-ref")).toHaveLength(2);
    expect(mainKinds(v)).not.toContain("tool-use");
    expect(mainKinds(v)).not.toContain("tool-result");
  });

  it("subagent-nested (depth-2): inner subagent linked under outer, status+result only, no inline turns", () => {
    const v = foldFixture("subagent-nested");
    // Two threads: the outer (top-level) and the inner (nested).
    const outerId = v.subagentOrder.find((id) => sub(v, id).parentId === undefined)!;
    const innerId = v.subagentOrder.find((id) => sub(v, id).parentId !== undefined)!;
    expect(outerId).toBeDefined();
    expect(innerId).toBeDefined();
    const outer = sub(v, outerId);
    const inner = sub(v, innerId);
    expect(inner.parentId).toBe(outerId);
    // Depth-2: the inner subagent's internal steps never inline → no turns, but it has status + result.
    expect(inner.turns).toHaveLength(0);
    expect(inner.status).toBe("completed");
    expect(subagentResultText(inner.result?.content)).toContain("NESTED-OK");
    // The outer's transcript holds the nested spawn as a subagent-ref pointing at the inner.
    expect(outer.turns.some((t) => t.kind === "subagent-ref" && t.id === innerId)).toBe(true);
    expect(outer.status).toBe("completed");
    // The inner's final result (delivered into the OUTER context) is NOT a generic tool-result in outer.
    expect(outer.turns.some((t) => t.kind === "tool-result")).toBe(false);
    // Main chat: only the OUTER subagent-ref appears (the inner is reachable via the outer's transcript).
    expect(mainKinds(v).filter((k) => k === "subagent-ref")).toHaveLength(1);
    const mainRef = v.turns.find((t) => t.kind === "subagent-ref");
    expect(mainRef).toEqual({ kind: "subagent-ref", id: outerId });
  });

  it("emptyView seeds the subagent registry", () => {
    const v = emptyView();
    expect(v.subagents).toEqual({});
    expect(v.subagentOrder).toEqual([]);
    expect(v.subagentTaskIndex).toEqual({});
  });
});
