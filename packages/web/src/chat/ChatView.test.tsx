import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { useStore } from "../store/store";
import type { ApiClient } from "../api/client";
import type { OutboundFrame, ServerFrame, SessionMeta } from "../types/server";

// jsdom provides a real WebSocket constructor that attempts to connect to the fake host and then
// fires async open/error/close events — those land outside act() and trigger the socket hook's
// status setState. Replace it with an inert stub so the socket is created and closed cleanly with
// no asynchronous state updates leaking past the test (this task does not exercise live frames).
class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = InertWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

let realWebSocket: typeof WebSocket;
beforeEach(() => {
  realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;
});

const session: SessionMeta = { id: "s1", cwd: "/home/u/proj", dangerouslySkip: false, status: "running", createdAt: 1 };

const history: ServerFrame[] = [
  {
    seq: 1,
    kind: "event",
    payload: { type: "assistant", message: { content: [{ type: "text", text: "Hello from history" }] } },
  },
  { seq: 2, kind: "result", payload: { type: "result", result: "All set", permissionDenials: [] } },
];

function apiStub(): ApiClient {
  return {
    listSessions: vi.fn(),
    // sinceSeq = the buffer's max seq; the WS resumes from here. The pushed permission/question frames
    // below use seq 99/100 (> sinceSeq) so they apply as new live frames.
    getSession: vi.fn(async () => ({ session, history, sinceSeq: 2 })),
    createSession: vi.fn(),
    stopSession: vi.fn(),
    listDir: vi.fn(),
    uploadFile: vi.fn(),
    downloadUrl: () => "",
  } as unknown as ApiClient;
}

afterEach(() => {
  // Unmount inside act() so the live socket's teardown (effect cleanup) is flushed within an
  // act-wrapped scope — otherwise the unmount's final state settle warns about an update outside act.
  act(() => {
    cleanup();
  });
  useStore.setState({ views: {} });
  globalThis.WebSocket = realWebSocket;
});

describe("ChatView", () => {
  async function renderSettled(api: ApiClient) {
    const utils = render(<ChatView session={session} api={api} token="t" />);
    // Flush the mount effect's async history load (getSession → applyFrames) inside act() so the
    // resulting store update + re-render are wrapped and no update leaks past the test.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  it("loads history into the store and renders it", async () => {
    await renderSettled(apiStub());
    // Every replayed frame is applied in a single store update, flushed inside act() above.
    // The assistant message renders; the turn-end marker is a quiet "done" (it no longer re-prints the
    // result text, which just duplicated the message — "All set" was the result copy).
    expect(screen.getByText(/hello from history/i)).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows 'Compacting…' while a /compact is in flight even though the wire is not in a working state", async () => {
    await renderSettled(apiStub());
    // After history load the wire is "success" (the history ends in a result) — NOT a working state. A
    // /compact emits no streaming/tool frames, so gating the indicator on `running` hid it the whole time.
    // The indicator must show purely from the `compacting` flag.
    act(() => {
      useStore.getState().setCompacting(session.id, true);
    });
    expect(await screen.findByText("Compacting…")).toBeInTheDocument();
  });

  it("on open, loads the FULL transcript (user + assistant in order) and sets lastSeq = sinceSeq", async () => {
    // Reopen bug regression: the user's OWN typed messages must survive a reopen (the buffer never held
    // them), correctly attributed, in order — and lastSeq must be the server's sinceSeq so the WS
    // resumes from there without re-rendering the shown history.
    const reopenHistory: ServerFrame[] = [
      {
        seq: 1,
        kind: "event",
        payload: { type: "user", uuid: "u1", message: { content: [{ type: "text", text: "what did I ask?" }] } },
      },
      {
        seq: 2,
        kind: "event",
        payload: { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "you asked X" }] } },
      },
    ];
    const api = {
      ...apiStub(),
      getSession: vi.fn(async () => ({ session, history: reopenHistory, sinceSeq: 9 })),
    } as unknown as ApiClient;
    await renderSettled(api);

    // The user's own message is shown ("You"), correctly attributed, before the assistant's reply.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("what did I ask?")).toBeInTheDocument();
    expect(screen.getByText("you asked X")).toBeInTheDocument();
    const turns = useStore.getState().viewFor(session.id).turns;
    expect(turns[0]).toEqual({ kind: "user", blocks: [{ type: "text", text: "what did I ask?" }], checkpointId: "u1" });
    expect(turns[1]).toEqual({ kind: "assistant-text", text: "you asked X" });
    // lastSeq is the server's sinceSeq (the WS resume point), NOT the transcript display seqs (1, 2).
    expect(useStore.getState().viewFor(session.id).lastSeq).toBe(9);

    // A live frame at/under sinceSeq is a no-op; a new one (seq > sinceSeq) appends without duplicating.
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 5,
        kind: "event",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "stale replay" }] } },
      });
    });
    expect(screen.queryByText("stale replay")).not.toBeInTheDocument();
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 10,
        kind: "event",
        payload: { type: "assistant", message: { content: [{ type: "text", text: "new live reply" }] } },
      });
    });
    expect(screen.getByText("new live reply")).toBeInTheDocument();
    expect(useStore.getState().viewFor(session.id).turns).toHaveLength(3);
  });

  it("shows the session cwd in the header", async () => {
    await renderSettled(apiStub());
    expect(screen.getByText("/home/u/proj")).toBeInTheDocument();
  });

  it("renders a top-left 'Show sessions' menu button (mobile-only) that calls onShowSessions", async () => {
    const onShowSessions = vi.fn();
    render(<ChatView session={session} api={apiStub()} token="t" onShowSessions={onShowSessions} needsYou={0} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const menu = screen.getByRole("button", { name: "Show sessions" });
    // Mobile-only: it carries the class the layout's @media (min-width:768px) rule hides on desktop.
    expect(menu).toHaveClass("rc-menu-btn");
    await userEvent.click(menu);
    expect(onShowSessions).toHaveBeenCalledTimes(1);
  });

  it("folds the needs-you count into the menu button's label and shows the iris pip", async () => {
    render(<ChatView session={session} api={apiStub()} token="t" onShowSessions={() => {}} needsYou={3} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The accessible name carries the count (never color-only), and a visible pip shows "3".
    const menu = screen.getByRole("button", { name: "Show sessions, 3 need you" });
    expect(menu).toHaveTextContent("3");
  });

  it("omits the header menu button when onShowSessions is not provided", async () => {
    render(<ChatView session={session} api={apiStub()} token="t" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /show sessions/i })).not.toBeInTheDocument();
  });

  it("the live-wire header reflects the session state (awaiting when a permission is pending)", async () => {
    await renderSettled(apiStub());

    // Drive a permission frame through the store; the header's LiveWire must move to "awaiting" (iris).
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 99,
        kind: "permission",
        payload: { requestId: "r1", kind: "can_use_tool", toolName: "Write" },
      });
    });

    const wire = await screen.findByRole("status");
    expect(wire).toHaveAttribute("data-state", "awaiting");
  });
});

// A WebSocket stub that reaches OPEN and captures outbound frames so we can assert what ChatView
// sends over the wire. It opens synchronously on the next microtask (flushed inside act()).
const sentFrames: OutboundFrame[] = [];
class CapturingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly OPEN = CapturingWebSocket.OPEN;
  readyState = CapturingWebSocket.OPEN; // open immediately so send() forwards
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    sentFrames.push(JSON.parse(data) as OutboundFrame);
  }
  close() {}
}

describe("ChatView — pending permission (allow/deny tool gate)", () => {
  let realWS: typeof WebSocket;
  beforeEach(() => {
    sentFrames.length = 0;
    realWS = globalThis.WebSocket;
    globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  async function mount(api: ApiClient) {
    const utils = render(<ChatView session={session} api={api} token="t" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  function pushPermission(requestId: string, toolName: string, seq: number) {
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq,
        kind: "permission",
        payload: { requestId, kind: "can_use_tool", toolName, toolInput: { file_path: "/tmp/x" } },
      });
    });
  }

  it("renders the pending permission prompt", async () => {
    await mount(apiStub());
    pushPermission("r1", "Write", 99);
    expect(await screen.findByRole("region", { name: /permission request/i })).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
  });

  it("optimistically shows the user's own sent message AND forwards the frame", async () => {
    await mount(apiStub());
    await userEvent.type(screen.getByLabelText("Message claude"), "hello claude");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    // The sender immediately sees their own message — claude does not echo typed user text as a turn,
    // so without the optimistic append the user would never see what they sent (the reported bug).
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("hello claude")).toBeInTheDocument();
    // ...and the frame actually went over the wire.
    expect(sentFrames.some((f) => f.type === "user" && f.text === "hello claude")).toBe(true);
    // The socket is open + Claude idle → the message is delivered: it shows a "Sent" confirmation (NOT a
    // blank, and NOT a stuck "Sending…"). This is the always-on delivery feedback.
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText(/Sending…/)).not.toBeInTheDocument();
  });

  it("shows 'Thinking…' the INSTANT a message is sent (before any frame), and clears it when the turn settles", async () => {
    await mount(apiStub());
    // The loaded history ended in a result → the strip is NOT already "Thinking…" before sending.
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Message claude"), "do a thing");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    // The reported bug: nothing showed until Claude's first frame. Now the telemetry bridges to "Thinking…"
    // immediately — no frame from Claude has arrived yet.
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    // When the turn settles (a result frame), the bridge clears.
    act(() => {
      useStore.getState().applyFrame(session.id, { seq: 100, kind: "result", payload: { subtype: "success" } });
    });
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("stays 'Thinking…' through a mid-turn lull (message_start + thinking-only frame) — never flashes 'Ready'", async () => {
    // The reported bug: "Thinking… yazıyor, aradan zaman geçiyor, Ready yazıyor." A real extended-thinking
    // turn opens with usage-only frames (message_start) and a thinking-only assistant block — neither sets a
    // working wire — so the old bridge handed off too early and the gap showed a stale "Ready".
    await mount(apiStub());
    await userEvent.type(screen.getByLabelText("Message claude"), "think hard then run a command");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    // message_start (usage only — no content): must stay "Thinking…".
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 10,
        kind: "event",
        payload: { type: "stream_event", event: { type: "message_start", message: { usage: { output_tokens: 2 } } } },
      });
    });
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    // The first assistant frame is a thinking-only block (no tool, no streamed text) → sets no working wire.
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 11,
        kind: "event",
        payload: { type: "assistant", message: { content: [{ type: "thinking", thinking: "let me reason" }] } },
      });
    });
    // The exact moment that used to read "Ready" — it must still read "Thinking…".
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    // Then the real tool frame arrives → the wire takes over with a truthful working label.
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 12,
        kind: "event",
        payload: {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] },
        },
      });
    });
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "running-tool");

    // Turn settles → the bridge is finally released.
    act(() => {
      useStore.getState().applyFrame(session.id, { seq: 99, kind: "result", payload: { subtype: "success" } });
    });
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("a permission prompt arriving during the bridge wins the display ('Awaiting you', not 'Thinking…')", async () => {
    await mount(apiStub());
    await userEvent.type(screen.getByLabelText("Message claude"), "write a file");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    pushPermission("rp", "Write", 100);
    await screen.findByRole("region", { name: /permission request/i });
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "awaiting");
  });

  it("reopening mid-turn (server reports a turn active) shows a working state, not idle", async () => {
    const api = {
      ...apiStub(),
      getSession: vi.fn(async () => ({ session, history, sinceSeq: 2, live: { turnActive: true } })),
    } as unknown as ApiClient;
    await mount(api);
    // live.turnActive seeds a working wire on reopen, so a chat reopened WHILE Claude is mid-turn shows
    // activity immediately instead of a wrong "Ready".
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "running-tool");
  });

  it("Allow sends {type:permission, decision:allow} and clears the pending prompt", async () => {
    await mount(apiStub());
    pushPermission("r1", "Write", 99);
    await screen.findByRole("region", { name: /permission request/i });

    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));

    expect(sentFrames).toContainEqual({ type: "permission", requestId: "r1", decision: "allow" });
    // The pending prompt clears once answered.
    expect(screen.queryByRole("region", { name: /permission request/i })).not.toBeInTheDocument();
  });

  it("Deny sends decision:deny and clears the pending prompt", async () => {
    await mount(apiStub());
    pushPermission("r1", "Write", 99);
    await screen.findByRole("region", { name: /permission request/i });

    await userEvent.click(screen.getByRole("button", { name: /^deny$/i }));

    expect(sentFrames).toContainEqual({ type: "permission", requestId: "r1", decision: "deny" });
    expect(screen.queryByRole("region", { name: /permission request/i })).not.toBeInTheDocument();
  });

  it("Always allow: a later permission for the same tool is auto-allowed without showing the prompt", async () => {
    await mount(apiStub());
    pushPermission("r1", "Write", 99);
    await screen.findByRole("region", { name: /permission request/i });

    // Register the per-session rule (and answer the current request allow).
    await userEvent.click(screen.getByRole("button", { name: /always allow/i }));
    expect(sentFrames).toContainEqual({ type: "permission", requestId: "r1", decision: "allow" });

    // A NEW permission for the same tool arrives — it must be auto-allowed, no prompt shown.
    pushPermission("r2", "Write", 100);
    await act(async () => {
      await Promise.resolve();
    });
    expect(sentFrames).toContainEqual({ type: "permission", requestId: "r2", decision: "allow" });
    expect(screen.queryByRole("region", { name: /permission request/i })).not.toBeInTheDocument();
  });

  it("shows the auto-allow chip with N=1 and expands to a clearable rule; clearing re-prompts that tool", async () => {
    await mount(apiStub());
    pushPermission("r1", "Write", 99);
    await screen.findByRole("region", { name: /permission request/i });
    await userEvent.click(screen.getByRole("button", { name: /always allow/i }));

    // The compact chip shows "N auto-allowed" near the composer.
    const chip = screen.getByRole("button", { name: /1 auto-allowed tool/i });
    expect(chip).toBeInTheDocument();
    expect(screen.getByText("auto-allowed")).toBeInTheDocument();

    // Expand the chip → the rule (Write) is listed with a clear control.
    await userEvent.click(chip);
    expect(screen.getByRole("listitem")).toHaveTextContent(/write/i);

    // Clear the rule → the chip disappears (N drops to 0).
    await userEvent.click(screen.getByRole("button", { name: /clear auto-allow for write/i }));
    expect(screen.queryByText("auto-allowed")).not.toBeInTheDocument();

    // A subsequent Write permission now prompts again (no longer auto-allowed).
    pushPermission("r3", "Write", 101);
    expect(await screen.findByRole("region", { name: /permission request/i })).toBeInTheDocument();
  });

  it("auto-allow is scoped to the tool: a different tool still prompts", async () => {
    await mount(apiStub());
    pushPermission("r1", "Write", 99);
    await screen.findByRole("region", { name: /permission request/i });
    await userEvent.click(screen.getByRole("button", { name: /always allow/i }));

    // A different tool is NOT covered by the Write rule → it must still prompt.
    pushPermission("r2", "Bash", 100);
    const region = await screen.findByRole("region", { name: /permission request/i });
    expect(region).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(sentFrames).not.toContainEqual({ type: "permission", requestId: "r2", decision: "allow" });
  });
});

describe("ChatView — pending ask_user question (answer carries askId)", () => {
  let realWS: typeof WebSocket;
  beforeEach(() => {
    sentFrames.length = 0;
    realWS = globalThis.WebSocket;
    globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  async function mount(api: ApiClient) {
    const utils = render(<ChatView session={session} api={api} token="t" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  function pushQuestion(askId: string, seq: number) {
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq,
        kind: "question",
        payload: {
          requestId: askId,
          askId,
          toolInput: { questions: [{ question: "Pick a tool?", multiSelect: false, options: [{ label: "esbuild" }] }] },
          questions: [{ question: "Pick a tool?", multiSelect: false, options: [{ label: "esbuild" }] }],
        },
      });
    });
  }

  it("renders the pending question prompt from a frame carrying askId", async () => {
    await mount(apiStub());
    pushQuestion("ask-1", 99);
    expect(await screen.findByRole("region", { name: /question/i })).toBeInTheDocument();
    expect(screen.getByText("Pick a tool?")).toBeInTheDocument();
  });

  it("Submit sends {type:answer, askId, answers} (no requestId/toolInput) and clears the prompt", async () => {
    await mount(apiStub());
    pushQuestion("ask-1", 99);
    await screen.findByRole("region", { name: /question/i });

    await userEvent.click(screen.getByRole("radio", { name: /esbuild/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));

    expect(sentFrames).toContainEqual({
      type: "answer",
      askId: "ask-1",
      answers: { "Pick a tool?": "esbuild" },
    });
    expect(screen.queryByRole("region", { name: /question/i })).not.toBeInTheDocument();
  });

  it("Skip on an ask_user question sends {type:answer, askId, answers:{}} so the held request resolves", async () => {
    await mount(apiStub());
    pushQuestion("ask-1", 99);
    await screen.findByRole("region", { name: /question/i });

    await userEvent.click(screen.getByRole("button", { name: /Skip/ }));

    expect(sentFrames).toContainEqual({ type: "answer", askId: "ask-1", answers: {} });
    expect(screen.queryByRole("region", { name: /question/i })).not.toBeInTheDocument();
  });

  it("legacy question (no askId): Submit routes by requestId+toolInput, Skip denies", async () => {
    await mount(apiStub());
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq: 99,
        kind: "question",
        payload: {
          requestId: "rq-legacy",
          toolInput: { questions: [{ question: "Old?", multiSelect: false, options: [{ label: "Yes" }] }] },
          questions: [{ question: "Old?", multiSelect: false, options: [{ label: "Yes" }] }],
        },
      });
    });
    await screen.findByRole("region", { name: /question/i });

    await userEvent.click(screen.getByRole("radio", { name: /^Yes$/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Submit/ }));

    expect(sentFrames).toContainEqual({
      type: "answer",
      requestId: "rq-legacy",
      toolInput: { questions: [{ question: "Old?", multiSelect: false, options: [{ label: "Yes" }] }] },
      answers: { "Old?": "Yes" },
    });
  });
});

describe("ChatView — REWIND / CHECKPOINT", () => {
  let realWS: typeof WebSocket;
  beforeEach(() => {
    sentFrames.length = 0;
    realWS = globalThis.WebSocket;
    globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = realWS;
  });

  async function mount(api: ApiClient) {
    const utils = render(<ChatView session={session} api={api} token="t" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return utils;
  }

  // Seed a rewindable user turn (carries a checkpointId) into the live view.
  function seedRewindableTurn(checkpointId: string, seq = 50) {
    act(() => {
      useStore.getState().applyFrame(session.id, {
        seq,
        kind: "event",
        payload: {
          type: "user",
          uuid: checkpointId,
          message: { content: [{ type: "text", text: "make the change" }] },
        },
      });
    });
  }

  it("tapping the rewind affordance opens the confirm sheet titled 'Rewind to here'", async () => {
    await mount(apiStub());
    seedRewindableTurn("cp-7");
    await userEvent.click(await screen.findByRole("button", { name: /rewind to here/i }));
    expect(await screen.findByRole("dialog", { name: /rewind to here/i })).toBeInTheDocument();
  });

  it("confirming the default (code) mode sends {type:rewind, checkpointId, mode:'code'}", async () => {
    await mount(apiStub());
    seedRewindableTurn("cp-7");
    await userEvent.click(await screen.findByRole("button", { name: /rewind to here/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm rewind/i }));
    expect(sentFrames).toContainEqual({ type: "rewind", checkpointId: "cp-7", mode: "code" });
  });

  it("choosing 'both' then confirming sends mode:'both', and the sheet closes", async () => {
    await mount(apiStub());
    seedRewindableTurn("cp-9");
    await userEvent.click(await screen.findByRole("button", { name: /rewind to here/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /both/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm rewind/i }));
    expect(sentFrames).toContainEqual({ type: "rewind", checkpointId: "cp-9", mode: "both" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancelling the sheet sends nothing and closes the dialog", async () => {
    await mount(apiStub());
    seedRewindableTurn("cp-1");
    await userEvent.click(await screen.findByRole("button", { name: /rewind to here/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    expect(sentFrames.some((f) => f.type === "rewind")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
