/**
 * TRUE end-to-end render test — the one seam no other test covers.
 *
 * It spans the WHOLE live stack into the browser's render state:
 *   mock-claude (a real child process) → real SessionManager/SessionHub → real Fastify + WS transport
 *   → the ACTUAL ServerFrames the WebSocket delivers → the REAL web frame-reducer (reduceFrame, imported
 *   by path like qa-replay.harness already does) → an assertion on the resulting SessionView.
 *
 * Why this exists (it closes a genuine gap):
 *   - qa-replay.harness HAND-MIRRORS the live transport (`liveFramesFromLines` reconstructs the dispatch);
 *     it never sends a real frame over a socket.
 *   - the server e2e tests (integration.e2e.test.ts) drive a real WS but STOP at the frame boundary — they
 *     assert frame KINDS, never folding them into a SessionView.
 *   This test is the only one where a server-emitted frame SHAPE that the reducer mis-folds would be caught:
 *   the frames are exactly the bytes the real client receives, and the fold is the exact reducer the app runs.
 *
 * It is a PERMANENT regression test: ≥2 scenarios (a plain turn; a tool+permission turn), asserting the
 * SessionView's turns + wireState, exactly-once user echo, and no raw-XML / "[object Object]" leak.
 */
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, ServerFrame } from "../src/index.js";
import { reduceFrame, emptyView, type SessionView } from "../../web/src/store/frame-reducer";
import { collectRenderable, LEAK_RE } from "./qa-replay.harness";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));
const TOKEN = "e2e-reducer-token";

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
});

/** Fold the REAL delivered frames through the REAL reducer, exactly as the web store does on the wire. */
function foldDelivered(frames: ServerFrame[]): SessionView {
  let view = emptyView();
  for (const f of frames) view = reduceFrame(view, f);
  return view;
}

/** Assert no rendered surface leaked raw-XML envelopes or "[object Object]" (the reducer's job is to keep
 *  the SessionView clean even though the wire carries the raw CLI shapes). */
function assertNoLeaks(view: SessionView): void {
  for (const piece of collectRenderable(view)) {
    expect(LEAK_RE.test(piece.text), `raw-XML leak in ${piece.kind}: ${piece.text.slice(0, 120)}`).toBe(false);
    expect(piece.text.includes("[object Object]"), `[object Object] in ${piece.kind}`).toBe(false);
  }
}

/**
 * Drive a real turn end-to-end and return BOTH the SessionView (folded from the exact delivered frames)
 * and the raw frame kinds, so a scenario can assert on either. `onPermission` is invoked with the live WS
 * when a `permission` frame arrives (so a tool turn can answer it), and the promise resolves at `result`.
 */
async function driveTurn(
  mockMode: string,
  userMessage: string,
  onPermission?: (ws: WebSocket, frame: ServerFrame) => void,
): Promise<{ view: SessionView; frames: ServerFrame[]; kinds: string[] }> {
  const config = configFor();
  const manager = new SessionManager(config.claude, {
    spawnPrefixArgs: [MOCK],
    // MOCK_REPLAY_USER makes the mock re-emit each user message like the real CLI's --replay-user-messages
    // (the flag config.ts always passes) — so the FULL faithful live path runs: the user echo folds into a
    // user bubble + checkpointId through the reducer, exactly as in production.
    baseEnv: { ...process.env, MOCK_MODE: mockMode, MOCK_REPLAY_USER: "1" },
    startTimeoutMs: 5000,
  });
  current = createServer(config, manager);
  const httpUrl = await current.app.listen({ port: 0, host: "127.0.0.1" });
  const wsBase = httpUrl.replace(/^http/, "ws");

  const created = await current.app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { cwd: process.cwd(), dangerouslySkip: false },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().session.id;

  const frames: ServerFrame[] = [];
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const ws = new WebSocket(`${wsBase}/sessions/${id}/ws?token=${TOKEN}`);
    ws.on("message", (raw: Buffer) => {
      // EXACTLY what the browser receives: the JSON bytes off the wire, parsed once.
      const frame: ServerFrame = JSON.parse(raw.toString());
      // `resync` is a socket-layer control signal, never folded into the view (mirror the web socket layer).
      if (frame.kind !== "resync") frames.push(frame);
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "user", content: userMessage }));
      }
      if (frame.kind === "permission" && onPermission) onPermission(ws, frame);
      if (frame.kind === "result") {
        ws.close();
        resolve();
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error(`e2e-reducer(${mockMode}): no result over ws`)), 10000);
  });

  const kinds = frames.map((f) => f.kind);
  return { view: foldDelivered(frames), frames, kinds };
}

test("scenario 1 — a plain turn folds into one user bubble + assistant text + a clean result", async () => {
  const { view, kinds } = await driveTurn("simple", "say hi");

  // The wire actually carried these kinds (proves the server emits them, not a hand-mirror).
  expect(kinds).toContain("event"); // assistant/stream/init events
  expect(kinds).toContain("result");

  // EXACTLY ONE user bubble for the single send (the live `user` echo must not draw a second one).
  const userTurns = view.turns.filter((t) => t.kind === "user");
  expect(userTurns.length).toBe(1);
  expect(userTurns[0]).toMatchObject({ kind: "user" });
  expect(
    (userTurns[0] as Extract<SessionView["turns"][number], { kind: "user" }>).blocks.some(
      (b) => b.type === "text" && b.text === "say hi",
    ),
  ).toBe(true);

  // The assistant prose surfaced as an assistant-text turn (the mock streams + finalizes "Hello").
  expect(view.turns.some((t) => t.kind === "assistant-text" && t.text === "Hello")).toBe(true);

  // The turn settled cleanly: a result turn, success wire, transient state cleared.
  expect(view.turns.some((t) => t.kind === "result")).toBe(true);
  expect(view.wireState).toBe("success");
  expect(view.liveText).toBe("");
  expect(view.awaitingReply).toBeFalsy();

  assertNoLeaks(view);
}, 20000);

test("scenario 2 — a tool+permission turn folds the tool call + result, and the prompt clears", async () => {
  let answered = false;
  const { view, kinds } = await driveTurn("permission", "write a file", (ws, frame) => {
    if (answered) return;
    answered = true;
    const requestId = (frame.payload as { requestId: string }).requestId;
    ws.send(JSON.stringify({ type: "permission", requestId, decision: "allow", reason: "e2e" }));
  });

  // The wire carried a real permission frame and a result (proves the server's permission path).
  expect(kinds).toContain("permission");
  expect(kinds).toContain("result");

  // The Write tool_use folded into a tool-use turn, and its tool_result into a tool-result turn.
  const toolUse = view.turns.find((t) => t.kind === "tool-use") as
    | Extract<SessionView["turns"][number], { kind: "tool-use" }>
    | undefined;
  expect(toolUse?.name).toBe("Write");
  expect(view.turns.some((t) => t.kind === "tool-result")).toBe(true);

  // The pending permission must be CLEARED by the turn's end (no lingering card), and the turn succeeded.
  expect(view.pendingPermission).toBeUndefined();
  expect(view.turns.some((t) => t.kind === "result")).toBe(true);
  expect(view.wireState).toBe("success");

  // Exactly one user bubble, no raw leaks into any surface.
  expect(view.turns.filter((t) => t.kind === "user").length).toBe(1);
  assertNoLeaks(view);
}, 20000);
