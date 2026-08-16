# Browser Terminal Backpressure and Stable Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the browser terminal responsive under sustained output on desktop Chrome and Android while preserving byte order, replay safety, and a stable terminal grid.

**Architecture:** Negotiate connection-scoped xterm parse acknowledgements and use them to bound each server socket to 256 KiB of sent-but-unparsed binary output. Aggregate foreground socket pressure at the terminal session, pause and resume `node-pty` with hysteresis, stabilize browser and server resizing, replace the tmux row-wiggle redraw with an exact-client redraw, and add WebGL only as a guarded accelerator with DOM fallback.

**Tech Stack:** TypeScript 6, Node.js 24, Fastify WebSocket, `ws`, `node-pty` 1.1.0, tmux, React 19, xterm.js 6, `@xterm/addon-webgl` 0.19, Vitest 4, Playwright 1.61, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-16-terminal-performance-flow-control-design.md`

## Global Constraints

- High watermark is exactly 256 KiB; low watermark is exactly 64 KiB; every flow-controlled binary frame is at most 64 KiB.
- A flow-controlled socket may retain at most 16 MiB of pending outbound data and may wait at most five seconds without ACK progress while pressured.
- A cumulative ACK is connection-scoped, monotonic, a finite safe integer, and never greater than bytes sent on that physical WebSocket.
- Never drop or reorder foreground output, acknowledge bytes before xterm's final write callback, or replay historical terminal side effects.
- A background or detached browser must never keep the shared PTY paused; foreground pressure from any healthy viewer pauses it.
- Resize changes are coalesced per animation frame, remotely debounced for 80 ms, and deduplicated after server-side clamping.
- A live reattach uses `tmux refresh-client -t <exact-pty-name>` and never changes the row count merely to force a redraw.
- WebGL is lazy and optional; missing support, SwiftShader, llvmpipe, activation failure, or context loss leaves the live DOM terminal functional.
- Preserve the existing 20,000-row browser scrollback, tmux replay/state handoff, keyboard semantics, attachment controls, reconnect behavior, and mixed-version compatibility.
- Tests use fake PTYs or unique isolated tmux sockets; do not mutate or restart an installed RoamCode service or use live sessions as fixtures.
- This implementation does not authorize a version bump, push, release workflow, tag, OTA activation, service restart, or publication.

---

## File map

### Server

- Create `packages/server/src/terminal-flow.ts`: one socket's ordered control/data queue, ACK validation, watermarks, stall timer, background replay recovery, and bounded memory.
- Create `packages/server/test/terminal-flow.test.ts`: deterministic unit coverage for the flow window independent of Fastify and a real PTY.
- Modify `packages/server/src/terminal-process.ts`: idempotent `pauseOutput()`, `resumeOutput()`, and exact-client `refreshClient()` wrappers.
- Modify `packages/server/test/terminal-process.test.ts`: fake-PTY coverage for pressure wrappers and tmux redraw argv.
- Modify `packages/server/src/terminal-manager.ts`: per-subscriber pressure state, multi-viewer aggregation, clamped resize deduplication, initial live-reattach sizing, and real tmux redraw.
- Modify `packages/server/test/terminal-manager.test.ts`: background/multi-viewer/cleanup pressure cases and no-wiggle reattach assertions.
- Modify `packages/server/src/transport.ts`: `flow=ack-v1` negotiation, ordered sender routing, ACK and visibility dispatch, and legacy fallback.
- Modify `packages/server/test/transport.terminal-ws.test.ts`: end-to-end WebSocket window, ordering, compatibility, failure, and reconnect tests.
- Modify `packages/server/test/helpers/test-server.ts`: observable fake `pause`, `resume`, PTY name, and resize state.

### Browser

- Modify `packages/web/src/api/client.ts` and `packages/web/src/api/client.test.ts`: advertise `flow=ack-v1` in ticket and legacy terminal URLs.
- Modify `packages/web/src/ws/terminal-socket.ts` and `packages/web/src/ws/terminal-socket.test.ts`: consume flow confirmation and ACK each parsed binary frame on its owning connection.
- Modify `packages/web/src/chat/terminal-output.ts` and `packages/web/src/chat/terminal-output.test.ts`: multi-frame replay accounting and composition with socket parse receipts.
- Create `packages/web/src/chat/terminal-resize.ts` and `packages/web/src/chat/terminal-resize.test.ts`: animation-frame coalescing, local fit dedupe, 80 ms remote stability, and per-connection send dedupe.
- Create `packages/web/src/chat/terminal-renderer.ts` and `packages/web/src/chat/terminal-renderer.test.ts`: hardware probe, software-renderer rejection, lazy WebGL activation, context-loss disposal, and DOM fallback.
- Modify `packages/web/src/chat/xterm-terminal.ts`: proposed dimensions, viewport-preserving fit, and non-blocking renderer startup.
- Modify `packages/web/src/chat/TerminalView.tsx` and `packages/web/src/chat/TerminalView.test.tsx`: wire parse receipts, replay guard, resize coordinator, and reconnect reset; the xterm adapter owns renderer lifecycle.
- Modify `packages/web/package.json` and `pnpm-lock.yaml`: add the compatible WebGL addon.

### Browser performance proof and user-facing note

- Create `packages/web/src/screenshot/terminal-performance-harness.ts` and `packages/web/src/screenshot/terminal-performance-harness.test.ts`: dev-only 64 KiB/256 KiB fake transport with parse and resize instrumentation.
- Modify `packages/web/src/screenshot/scenes.tsx`: expose the bounded output pump and opt-in visible-echo probe without shipping globals in the production entrypoint.
- Modify `packages/web/scripts/mobile-smoke.mjs`: desktop and Pixel 7/4x CPU echo timing, strict flow-window/order checks, resize-burst checks, and DOM/WebGL-compatible renderer assertions.
- Modify `CHANGELOG.md`: add one concise `Unreleased`/`Fixed` bullet describing the user-visible responsiveness and screen-stability repair.

---

### Task 1: Build the per-socket terminal flow window

**Files:**
- Create: `packages/server/src/terminal-flow.ts`
- Create: `packages/server/test/terminal-flow.test.ts`

**Interfaces:**
- Consumes: Node `Buffer`, ordinary `setTimeout`/`clearTimeout`, and four transport callbacks.
- Produces: `TERMINAL_FLOW_LIMITS`, `TerminalAckResult`, `TerminalFlowCloseReason`, `TerminalFlowWindowCallbacks`, and `TerminalFlowWindow` with the exact public surface below.

- [ ] **Step 1: Write the failing framing and ACK-window tests**

Create `packages/server/test/terminal-flow.test.ts` with a small recorder and assert that exactly four 64 KiB frames leave before an ACK, the fifth leaves only after progress, controls cannot overtake queued binary data, and cumulative counters are exposed:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TERMINAL_FLOW_LIMITS, TerminalFlowWindow } from "../src/terminal-flow.js";

function flowRecorder() {
  const binary: Buffer[] = [];
  const text: string[] = [];
  const pressure: boolean[] = [];
  const closed: string[] = [];
  const flow = new TerminalFlowWindow({
    sendBinary: (frame) => binary.push(Buffer.from(frame)),
    sendText: (frame) => text.push(frame),
    onPressure: (value) => pressure.push(value),
    onClose: (reason) => closed.push(reason),
  });
  return { flow, binary, text, pressure, closed };
}

describe("TerminalFlowWindow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("sends at most 256 KiB in 64 KiB frames until cumulative parse progress", () => {
    const { flow, binary, pressure } = flowRecorder();
    flow.setViewing(true);
    flow.enqueueData(Buffer.alloc(TERMINAL_FLOW_LIMITS.highWatermarkBytes + 17, 0x61));

    expect(binary.map((frame) => frame.byteLength)).toEqual([65536, 65536, 65536, 65536]);
    expect(flow.unacknowledgedBytes).toBe(262144);
    expect(flow.pendingBytes).toBe(17);
    expect(pressure).toEqual([true]);

    expect(flow.acknowledge(65536)).toBe("advanced");
    expect(binary.at(-1)?.byteLength).toBe(17);
    expect(flow.sentBytes).toBe(262161);
  });

  test("keeps replay end behind all replay bytes retained by the window", () => {
    const { flow, binary, text } = flowRecorder();
    flow.enqueueControl('{"t":"terminal-replay","phase":"begin"}');
    flow.enqueueData(Buffer.alloc(262145, 0x62));
    flow.enqueueControl('{"t":"terminal-replay","phase":"end"}');

    expect(text).toEqual(['{"t":"terminal-replay","phase":"begin"}']);
    flow.acknowledge(65536);
    expect(Buffer.concat(binary).byteLength).toBe(262145);
    expect(text.at(-1)).toBe('{"t":"terminal-replay","phase":"end"}');
  });

  test("splits encoded UTF-8 bytes without changing their byte order", () => {
    const { flow, binary } = flowRecorder();
    const source = Buffer.from("🙂漢字".repeat(40_000), "utf8");
    flow.enqueueData(source);
    while (flow.pendingBytes > 0) flow.acknowledge(flow.sentBytes);
    expect(Buffer.concat(binary)).toEqual(source);
    expect(binary.every((frame) => frame.byteLength <= 65_536)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-flow.test.ts
```

Expected: FAIL because `packages/server/src/terminal-flow.ts` does not exist.

- [ ] **Step 3: Define the exact flow-window API and constants**

Create `packages/server/src/terminal-flow.ts` with these exported contracts and a private ordered queue whose text entries record UTF-8 memory bytes and whose binary entries record an offset:

```ts
export const TERMINAL_FLOW_LIMITS = {
  version: 1,
  highWatermarkBytes: 256 * 1024,
  lowWatermarkBytes: 64 * 1024,
  maxFrameBytes: 64 * 1024,
  maxPendingBytes: 16 * 1024 * 1024,
  stallMs: 5_000,
} as const;

export type TerminalAckResult = "advanced" | "ignored" | "invalid";
export type TerminalFlowCloseReason = "protocol" | "stalled" | "overflow" | "replay-required" | "transport";

export interface TerminalFlowWindowCallbacks {
  sendBinary(frame: Buffer): void;
  sendText(frame: string): void;
  onPressure(pressured: boolean): void;
  onClose(reason: TerminalFlowCloseReason): void;
}

export class TerminalFlowWindow {
  constructor(callbacks: TerminalFlowWindowCallbacks);
  get sentBytes(): number;
  get acknowledgedBytes(): number;
  get unacknowledgedBytes(): number;
  get pendingBytes(): number;
  get pressured(): boolean;
  get needsReplay(): boolean;
  enqueueData(chunk: string | Buffer): void;
  enqueueControl(frame: string): void;
  acknowledge(parsedBytes: number): TerminalAckResult;
  setViewing(viewing: boolean): void;
  dispose(): void;
}
```

Implement `drain()` so it sends queue-head text immediately, slices queue-head binary by both `maxFrameBytes` and remaining high-window capacity, counts only binary toward sent/ACK totals, and never advances a later item before the current item is complete. Start in a provisional foreground state so an initial replay is retained until the browser's visibility frame arrives. The transport does not apply provisional pressure to the manager until its subscriber exists; the manager subscriber itself remains non-viewing until the explicit browser frame.

- [ ] **Step 4: Add validation, hysteresis, stall, overflow, and background recovery tests**

Append exact cases that assert:

```ts
test("validates cumulative ACKs without oscillating pressure", () => {
  const { flow, pressure, closed } = flowRecorder();
  flow.setViewing(true);
  flow.enqueueData(Buffer.alloc(300_000));

  expect(flow.acknowledge(Number.NaN)).toBe("invalid");
  expect(flow.acknowledge(-1)).toBe("invalid");
  expect(flow.acknowledge(1.5)).toBe("invalid");
  expect(flow.acknowledge(Number.MAX_SAFE_INTEGER + 1)).toBe("invalid");
  expect(flow.acknowledge(262145)).toBe("invalid");
  expect(flow.acknowledge(0)).toBe("ignored");
  expect(flow.acknowledge(100_000)).toBe("advanced");
  expect(flow.acknowledge(99_999)).toBe("ignored");
  expect(flow.acknowledge(100_000)).toBe("ignored");
  expect(pressure).toEqual([true]);
  expect(closed).toEqual([]);

  flow.acknowledge(flow.sentBytes - 65_537);
  expect(pressure).toEqual([true]);
  flow.acknowledge(flow.sentBytes - 65_536);
  expect(pressure).toEqual([true, false]);
});

test("closes a foreground stall after five seconds and releases pressure first", () => {
  const { flow, pressure, closed } = flowRecorder();
  flow.setViewing(true);
  flow.enqueueData(Buffer.alloc(300_000));
  vi.advanceTimersByTime(4_999);
  expect(closed).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(pressure.at(-1)).toBe(false);
  expect(closed).toEqual(["stalled"]);
});

test("ACK progress rearms the five-second pressure deadline", () => {
  const { flow, closed } = flowRecorder();
  flow.setViewing(true);
  flow.enqueueData(Buffer.alloc(600_000));
  vi.advanceTimersByTime(4_000);
  flow.acknowledge(65_536);
  vi.advanceTimersByTime(4_999);
  expect(closed).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(closed).toEqual(["stalled"]);
});

test("background overflow skips output and requests one replay only on foreground return", () => {
  const { flow, pressure, closed } = flowRecorder();
  flow.setViewing(false);
  flow.enqueueData(Buffer.alloc(300_000));
  expect(flow.needsReplay).toBe(true);
  expect(flow.pendingBytes).toBe(0);
  expect(pressure).toEqual([]);
  flow.enqueueData(Buffer.alloc(10));
  expect(flow.sentBytes).toBe(262144);
  expect(closed).toEqual([]);
  flow.setViewing(true);
  flow.setViewing(true);
  expect(closed).toEqual(["replay-required"]);
});

test("a healthy background subscriber can ACK without pausing or entering replay recovery", () => {
  const { flow, pressure, closed } = flowRecorder();
  flow.setViewing(false);
  flow.enqueueData(Buffer.alloc(200_000));
  expect(flow.needsReplay).toBe(false);
  expect(flow.acknowledge(200_000)).toBe("advanced");
  expect(pressure).toEqual([]);
  expect(closed).toEqual([]);
});

test("rejects a foreground queue above 16 MiB without allocating the rejected tail", () => {
  const { flow, closed } = flowRecorder();
  flow.setViewing(true);
  flow.enqueueData(Buffer.alloc(TERMINAL_FLOW_LIMITS.maxPendingBytes + TERMINAL_FLOW_LIMITS.highWatermarkBytes + 1));
  expect(closed).toEqual(["overflow"]);
  expect(flow.pendingBytes).toBe(0);
});

test("turns a socket send exception into one transport close", () => {
  const closed: string[] = [];
  const flow = new TerminalFlowWindow({
    sendBinary: () => { throw new Error("socket gone"); },
    sendText: () => {},
    onPressure: () => {},
    onClose: (reason) => closed.push(reason),
  });
  flow.enqueueData("lost");
  flow.enqueueData("ignored after close");
  expect(closed).toEqual(["transport"]);
});
```

For an invalid ACK, leave closure to the transport and return `"invalid"`. Before converting a string into a `Buffer`, reject a new item when its UTF-8 size exceeds the remaining high-window capacity plus the 16 MiB pending budget; count retained text-control bytes in the same pending budget. Rearm one unref'd five-second timer on every advanced ACK while pressure remains, and clear it as soon as pressure releases. For internal stall/overflow/replay recovery or a thrown `sendBinary`/`sendText`, clear the queue, clear the timer, emit `onPressure(false)` when needed, and call `onClose` once. A thrown send uses the `"transport"` reason.

- [ ] **Step 5: Run the flow-window tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-flow.test.ts
```

Expected: PASS with every framing, order, validation, hysteresis, timeout, memory, and background assertion green.

- [ ] **Step 6: Commit the isolated flow primitive**

```bash
git add packages/server/src/terminal-flow.ts packages/server/test/terminal-flow.test.ts
git commit -m "feat: add bounded terminal flow window"
```

### Task 2: Add PTY pressure and exact tmux client redraw primitives

**Files:**
- Modify: `packages/server/src/terminal-process.ts:8-58,430-533`
- Modify: `packages/server/test/terminal-process.test.ts:14-27` and append focused tests

**Interfaces:**
- Consumes: `IPty.pause()`, `IPty.resume()`, optional Unix `ptsName`, the existing injected `runTmux(args)` callback, and the dedicated tmux socket.
- Produces: `TerminalProcess.pauseOutput(): void`, `resumeOutput(): void`, and `refreshClient(): boolean`.

- [ ] **Step 1: Extend the fake PTY and write failing idempotence/redraw tests**

Add `pause`, `resume`, `ptsName`, and counters to `fakePty()`, then add:

```ts
test("output pressure pauses and resumes node-pty idempotently", () => {
  const { pty, calls } = fakePty();
  const tp = new TerminalProcess({
    sessionId: "pressure",
    cwd: "/work",
    executable: "/bin/sh",
    ptySpawn: (() => pty) as never,
  });
  tp.start();
  tp.pauseOutput();
  tp.pauseOutput();
  tp.resumeOutput();
  tp.resumeOutput();
  expect(calls.paused).toBe(1);
  expect(calls.resumed).toBe(1);
});

test("refreshClient targets the exact node-pty slave on the dedicated tmux socket", () => {
  const { pty } = fakePty();
  pty.ptsName = "/dev/pts/test-client";
  const runTmux = vi.fn();
  const tp = new TerminalProcess({
    sessionId: "redraw",
    cwd: "/work",
    executable: "/bin/sh",
    tmuxSocket: "isolated-test-socket",
    ptySpawn: (() => pty) as never,
    runTmux,
  });
  tp.start();
  expect(tp.refreshClient()).toBe(true);
  expect(runTmux).toHaveBeenCalledWith([
    "-L",
    "isolated-test-socket",
    "refresh-client",
    "-t",
    "/dev/pts/test-client",
  ]);
});

test("refreshClient declines redraw when the PTY name is unavailable", () => {
  const { pty } = fakePty();
  const runTmux = vi.fn();
  const tp = new TerminalProcess({
    sessionId: "no-target",
    cwd: "/work",
    executable: "/bin/sh",
    ptySpawn: (() => pty) as never,
    runTmux,
  });
  tp.start();
  expect(tp.refreshClient()).toBe(false);
  expect(runTmux).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-process.test.ts
```

Expected: FAIL because the three `TerminalProcess` methods and fake counters are absent.

- [ ] **Step 3: Implement guarded wrappers without a shell or redraw heuristic**

Extend the local PTY interface and process state exactly as follows:

```ts
export interface IPty {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  pause?(): void;
  resume?(): void;
  readonly ptsName?: string;
  kill(sig?: string): void;
}

private outputPaused = false;

pauseOutput(): void {
  if (this.outputPaused || !this.pty?.pause) return;
  try {
    this.pty.pause();
    this.outputPaused = true;
  } catch {
    // A disappearing PTY is handled by its ordinary exit path.
  }
}

resumeOutput(): void {
  if (!this.outputPaused) return;
  this.outputPaused = false;
  try {
    this.pty?.resume?.();
  } catch {
    // A disappearing PTY is handled by its ordinary exit path.
  }
}

refreshClient(): boolean {
  const target = this.pty?.ptsName;
  if (typeof target !== "string" || target.length === 0) return false;
  this.runTmux(["-L", this.tmuxSocket, "refresh-client", "-t", target]);
  return true;
}
```

Reset `outputPaused` when a PTY starts and call `resumeOutput()` before killing or forgetting a paused PTY in `stop()`.
Update the `runTmux` option and default-runner comments to describe a generic one-shot tmux command (`refresh-client` and `kill-session`); keep the existing argv-only, no-shell, unref'd spawn behavior.

- [ ] **Step 4: Run process tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-process.test.ts packages/server/test/terminal-real-tmux.integration.test.ts
```

Expected: PASS; the real-tmux test continues to use only its unique socket.

- [ ] **Step 5: Commit the PTY primitives**

```bash
git add packages/server/src/terminal-process.ts packages/server/test/terminal-process.test.ts
git commit -m "feat: control terminal PTY output pressure"
```

### Task 3: Aggregate viewer pressure and stabilize server-side resize/reattach

**Files:**
- Modify: `packages/server/src/terminal-manager.ts:100-124,1059-1079,1150-1310,1669-1686`
- Modify: `packages/server/test/terminal-manager.test.ts:29-83,480-517` and append pressure tests

**Interfaces:**
- Consumes: Task 2's `pauseOutput()`, `resumeOutput()`, and `refreshClient()`.
- Produces: `TerminalSub.setOutputPressure(pressured: boolean): void`; manager-side any-foreground pressure aggregation; clamped resize no-op; one stable live-reattach resize followed by exact redraw.

- [ ] **Step 1: Make fake PTYs observable and replace the old wiggle expectation with failing stable-redraw tests**

Give `fakePtyFactory()` PTYs `pause`, `resume`, `ptsName`, `pauses`, and `resumes`. Replace the existing size-wiggle test with:

```ts
test("live reattach applies its requested size once and redraws the exact tmux client without a row wiggle", async () => {
  const store = openSessionStore({ dbPath: ":memory:" });
  const { spawn, ptys } = fakePtyFactory();
  const runTmux = vi.fn();
  const manager = new TerminalManager({
    store,
    providers: claudeRegistry(),
    now: () => 1,
    ptySpawn: spawn as never,
    runTmux,
    tmuxSocket: "manager-test-socket",
  });
  manager.createLegacyClaude({ id: "a", cwd: "/w" });
  await manager.attach("a", { onData: () => {} }, { cols: 80, rows: 24 });
  const pty = ptys[0]!;
  pty.ptsName = "/dev/pts/manager-client";
  const before = pty.resizes.length;

  await manager.attach("a", { onData: () => {} }, { cols: 101, rows: 31 });

  expect(pty.resizes.slice(before)).toEqual([[101, 31]]);
  expect(runTmux).toHaveBeenCalledWith([
    "-L",
    "manager-test-socket",
    "refresh-client",
    "-t",
    "/dev/pts/manager-client",
  ]);
  expect(pty.resizes).not.toContainEqual([101, 32]);
});

test("identical dimensions are a server-side PTY no-op after clamping", async () => {
  const { m, ptys } = mgr();
  m.createLegacyClaude({ id: "same", cwd: "/w" });
  await m.attach("same", { onData: () => {} }, { cols: 80, rows: 24 });
  const before = ptys[0]!.resizes.length;
  m.resize("same", 80, 24);
  m.resize("same", 80.9, 24.2);
  expect(ptys[0]!.resizes).toHaveLength(before);
});
```

- [ ] **Step 2: Add failing foreground/background and multi-viewer pressure tests**

Append:

```ts
test("only foreground pressure pauses and all teardown paths release it", async () => {
  const { m, ptys } = mgr();
  m.createLegacyClaude({ id: "pressure", cwd: "/w" });
  const foreground = await m.attach("pressure", { onData: () => {} });
  const background = await m.attach("pressure", { onData: () => {} });
  const pty = ptys[0]!;

  background!.setViewing(false);
  background!.setOutputPressure(true);
  expect(pty.pauses).toBe(0);

  foreground!.setViewing(true);
  foreground!.setOutputPressure(true);
  foreground!.setOutputPressure(true);
  expect(pty.pauses).toBe(1);

  background!.setViewing(true);
  foreground!.setOutputPressure(false);
  expect(pty.resumes).toBe(0);
  background!.unsubscribe();
  expect(pty.resumes).toBe(1);
});

test("stop resumes a pressured PTY before killing the session", async () => {
  const { m, ptys } = mgr();
  m.createLegacyClaude({ id: "stop-pressure", cwd: "/w" });
  const sub = await m.attach("stop-pressure", { onData: () => {} });
  sub!.setViewing(true);
  sub!.setOutputPressure(true);
  m.stop("stop-pressure");
  expect(ptys[0]!.pauses).toBe(1);
  expect(ptys[0]!.resumes).toBe(1);
});
```

Also extend the existing natural-exit test to pressure a foreground subscriber first and assert one resume before subscriber cleanup.

- [ ] **Step 3: Run the manager tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-manager.test.ts
```

Expected: FAIL on missing `setOutputPressure`, continued duplicate resize calls, and the old timer-driven redraw.

- [ ] **Step 4: Implement per-subscriber pressure aggregation**

Extend the public and internal subscriber contracts:

```ts
export interface TerminalSub {
  unsubscribe(): void;
  setViewing(viewing: boolean): void;
  setOutputPressure(pressured: boolean): void;
}

interface TermSub {
  // existing sinks
  viewing: boolean;
  outputPressured: boolean;
}

private syncOutputPressure(rec: Record_): void {
  const shouldPause = [...rec.subs].some((sub) => sub.viewing && sub.outputPressured);
  if (shouldPause) rec.proc?.pauseOutput();
  else rec.proc?.resumeOutput();
}
```

Initialize `outputPressured: false`. Call `syncOutputPressure(rec)` after viewing changes, pressure changes, subscriber deletion, successful process publication, and before process stop/exit cleanup. Repeated values return early.

- [ ] **Step 5: Replace dimension-changing redraw and deduplicate resize**

Delete `forceRedraw` and both timers. At the start of `attach`, clamp any supplied size whether the process is new or live; call `rec.proc.resize` only when the clamped pair differs. Preserve replay and terminal-state seed order, then call `rec.proc.refreshClient()` for `joinedLiveProcess`.

Implement the public resize path as:

```ts
resize(id: string, cols: number, rows: number): void {
  const rec = this.records.get(id);
  if (!rec) return;
  const nextCols = clampDim(cols, rec.cols);
  const nextRows = clampDim(rows, rec.rows);
  if (nextCols === rec.cols && nextRows === rec.rows) return;
  rec.cols = nextCols;
  rec.rows = nextRows;
  rec.proc?.resize(nextCols, nextRows);
}
```

- [ ] **Step 6: Run manager/process tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-manager.test.ts packages/server/test/terminal-process.test.ts
```

Expected: PASS with zero extra-row resize, exact tmux target, and balanced pressure across viewers and cleanup.

- [ ] **Step 7: Commit session-level pressure and stable redraw**

```bash
git add packages/server/src/terminal-manager.ts packages/server/test/terminal-manager.test.ts
git commit -m "fix: stabilize terminal pressure and reattach redraw"
```

### Task 4: Negotiate ACK flow control in the terminal WebSocket transport

**Files:**
- Modify: `packages/server/src/transport.ts:77-84,1098-1308`
- Modify: `packages/server/test/transport.terminal-ws.test.ts`
- Modify: `packages/server/test/helpers/test-server.ts:30-107`

**Interfaces:**
- Consumes: Task 1's `TerminalFlowWindow`; Task 3's `TerminalSub.setOutputPressure()`.
- Produces: `flow=ack-v1` server negotiation, `{t:"terminal-flow",v:1,high:262144,low:65536,chunk:65536}` confirmation, `{t:"a",n}` handling, ordered replay/control/data delivery, and unchanged legacy behavior without the capability.

- [ ] **Step 1: Extend the shared test fake and write the failing 256 KiB WebSocket integration test**

Add `_pauses`, `_resumes`, `pause()`, `resume()`, and a deterministic non-machine PTY target such as `/dev/pts/roamcode-test-<id>` to `FakePty` and accessor methods `pausesFor(id)`/`resumesFor(id)`.

In `transport.terminal-ws.test.ts`, add a helper that records binary/text frames and then add:

```ts
test("ack-v1 sends four 64 KiB frames, pauses once, and resumes only below 64 KiB", async () => {
  const { app, token, fakePty, listen, wsConnect, terminalManager } = await buildTestServer({
    terminalAvailable: true,
  });
  await listen();
  const id = "flow-window";
  terminalManager.create({
    id,
    cwd: process.cwd(),
    provider: "claude",
    options: { provider: "claude", dangerouslySkip: false },
  });
  const ws = wsConnect(`/sessions/${id}/terminal?token=${token}&flow=ack-v1`);
  const frames: Array<{ binary: boolean; data: Buffer }> = [];
  ws.on("message", (data, binary) => frames.push({ binary, data: Buffer.from(data as never) }));
  await openWs(ws);
  ws.send(JSON.stringify({ t: "v", v: true }));
  await expect.poll(() => fakePty.argsFor(id).length).toBeGreaterThan(0);

  fakePty.lastForId(id).emit("data", "x".repeat(300_000));
  await expect.poll(() => frames.filter((frame) => frame.binary)).toHaveLength(4);
  expect(frames.filter((frame) => frame.binary).map((frame) => frame.data.byteLength)).toEqual([
    65536, 65536, 65536, 65536,
  ]);
  expect(fakePty.pausesFor(id)).toBe(1);

  ws.send(JSON.stringify({ t: "a", n: 65_536 }));
  await expect.poll(() => frames.filter((frame) => frame.binary)).toHaveLength(5);
  expect(fakePty.resumesFor(id)).toBe(0);
  ws.send(JSON.stringify({ t: "a", n: 234_464 }));
  await expect.poll(() => fakePty.resumesFor(id)).toBe(1);
  ws.close();
  await app.close();
});
```

- [ ] **Step 2: Add failing negotiation, replay order, invalid ACK, and legacy tests**

Add this shared fixture immediately below `openWs`:

```ts
async function terminalWsFixture(options: { flow: boolean; viewing: boolean } = { flow: true, viewing: true }) {
  const server = await buildTestServer({ terminalAvailable: true });
  await server.listen();
  const id = "flow-fixture";
  server.terminalManager.create({
    id,
    cwd: process.cwd(),
    provider: "claude",
    options: { provider: "claude", dangerouslySkip: false },
  });
  const suffix = options.flow ? "&flow=ack-v1" : "";
  const ws = server.wsConnect(`/sessions/${id}/terminal?token=${server.token}${suffix}`);
  const frames: Array<{ binary: boolean; value: Buffer }> = [];
  ws.on("message", (data, binary) => frames.push({ binary, value: Buffer.from(data as never) }));
  await openWs(ws);
  ws.send(JSON.stringify({ t: "v", v: options.viewing }));
  await expect.poll(() => server.fakePty.argsFor(id).length).toBeGreaterThan(0);
  return { ...server, id, ws, frames };
}
```

Then add the four complete behaviors:

```ts
test("ack-v1 confirmation is the first terminal frame and streamed replay end cannot overtake data", async () => {
  const first = await terminalWsFixture({ flow: false, viewing: true });
  const history = "history-row\r\n".repeat(25_000);
  first.fakePty.lastForId(first.id).emit("data", history);
  await expect.poll(() => first.frames.some((frame) => frame.binary && frame.value.byteLength === Buffer.byteLength(history))).toBe(true);
  const firstClosed = new Promise<void>((resolve) => first.ws.once("close", () => resolve()));
  first.ws.close();
  await firstClosed;

  const ws = first.wsConnect(`/sessions/${first.id}/terminal?token=${first.token}&flow=ack-v1`);
  const frames: Array<{ binary: boolean; value: Buffer }> = [];
  ws.on("message", (data, binary) => frames.push({ binary, value: Buffer.from(data as never) }));
  await openWs(ws);
  ws.send(JSON.stringify({ t: "v", v: true }));
  await expect.poll(() => frames.filter((frame) => frame.binary)).toHaveLength(4);

  expect(JSON.parse(frames[0]!.value.toString())).toEqual({
    t: "terminal-flow",
    v: 1,
    high: 262144,
    low: 65536,
    chunk: 65536,
  });
  expect(frames.some((frame) => frame.value.toString() === JSON.stringify({ t: "terminal-replay", phase: "end" }))).toBe(false);

  const firstBatchBytes = frames.filter((frame) => frame.binary).reduce((sum, frame) => sum + frame.value.byteLength, 0);
  ws.send(JSON.stringify({ t: "a", n: firstBatchBytes }));
  await expect.poll(() => frames.some((frame) => frame.value.toString() === JSON.stringify({ t: "terminal-replay", phase: "end" }))).toBe(true);
  const begin = frames.findIndex((frame) => frame.value.toString() === JSON.stringify({ t: "terminal-replay", phase: "begin" }));
  const end = frames.findIndex((frame) => frame.value.toString() === JSON.stringify({ t: "terminal-replay", phase: "end" }));
  expect(begin).toBeGreaterThan(0);
  expect(frames.slice(begin + 1, end).every((frame) => frame.binary)).toBe(true);
  expect(Buffer.concat(frames.slice(begin + 1, end).map((frame) => frame.value)).toString()).toBe(history);
  ws.close();
  await first.app.close();
});

test("an ACK beyond sent bytes closes transiently and releases PTY pressure", async () => {
  const fixture = await terminalWsFixture();
  fixture.fakePty.lastForId(fixture.id).emit("data", "x".repeat(300_000));
  await expect.poll(() => fixture.fakePty.pausesFor(fixture.id)).toBe(1);
  const closed = new Promise<number>((resolve) => fixture.ws.once("close", (code) => resolve(code)));
  fixture.ws.send(JSON.stringify({ t: "a", n: 262_145 }));
  expect(await closed).toBe(4400);
  expect(fixture.fakePty.resumesFor(fixture.id)).toBe(1);
  await fixture.app.close();
});

test("a terminal socket without the capability keeps legacy framing and ignores ACK messages", async () => {
  const fixture = await terminalWsFixture({ flow: false, viewing: true });
  fixture.fakePty.lastForId(fixture.id).emit("data", "y".repeat(300_000));
  await expect.poll(() => fixture.frames.filter((frame) => frame.binary)).toHaveLength(1);
  expect(fixture.frames.find((frame) => frame.binary)?.value.byteLength).toBe(300_000);
  fixture.ws.send(JSON.stringify({ t: "a", n: 300_000 }));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  expect(fixture.ws.readyState).toBe(fixture.ws.OPEN);
  expect(fixture.fakePty.pausesFor(fixture.id)).toBe(0);
  fixture.ws.close();
  await fixture.app.close();
});

test("background overflow never pauses the PTY and reconnects once when visible", async () => {
  const fixture = await terminalWsFixture({ flow: true, viewing: false });
  fixture.fakePty.lastForId(fixture.id).emit("data", "z".repeat(300_000));
  await expect.poll(() => fixture.frames.filter((frame) => frame.binary)).toHaveLength(4);
  expect(fixture.fakePty.pausesFor(fixture.id)).toBe(0);
  const closed = new Promise<number>((resolve) => fixture.ws.once("close", (code) => resolve(code)));
  fixture.ws.send(JSON.stringify({ t: "v", v: true }));
  expect(await closed).toBe(4400);
  expect(fixture.fakePty.pausesFor(fixture.id)).toBe(0);
  await fixture.app.close();
});
```

- [ ] **Step 3: Run the transport test and verify RED**

Run:

```bash
pnpm exec vitest run packages/server/test/transport.terminal-ws.test.ts
```

Expected: FAIL because the route neither negotiates flow control nor routes output through the ordered sender.

- [ ] **Step 4: Wire negotiation and ordered output into the route**

Extend both Fastify query types with `flow?: string`, import Task 1's helper, and construct it only for `request.query.flow === "ack-v1"`. Map close reasons to transient close code 4400 and public-safe reason strings:

```ts
const FLOW_CLOSE_TEXT: Record<TerminalFlowCloseReason, string> = {
  protocol: "terminal flow protocol",
  stalled: "terminal flow stalled",
  overflow: "terminal flow overflow",
  "replay-required": "terminal replay required",
  transport: "terminal transport failed",
};
```

Send the confirmation through `enqueueControl` before calling `terminalManager.attach`. Route every `onData` and `onControl` callback through the flow window when present; retain the current `bufferedAmount` legacy branches when absent. Keep exit closure immediate.

- [ ] **Step 5: Route visibility and ACK messages before delayed attach completes**

Extend the parsed type with `n?: number`. Keep `let currentViewing: boolean | undefined` and `let currentPressure = false`. For a parsed visibility frame, update the flow window immediately and either update the attached subscriber or retain the value. For ACK, call `acknowledge` immediately; close on `"invalid"`. Queue only input/resize frames while attach is pending.

After attach resolves, apply state in this order:

```ts
sub = attached;
if (currentViewing !== undefined) sub.setViewing(currentViewing);
sub.setOutputPressure(currentPressure);
for (const frame of pendingFrames) dispatchInput(frame);
```

The flow callback always updates `currentPressure` and calls `sub?.setOutputPressure(value)`. `detach()` calls `flow?.dispose()` before `sub.unsubscribe()` so every close/error/abort releases pressure synchronously.

- [ ] **Step 6: Run server flow, manager, and transport tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/server/test/terminal-flow.test.ts packages/server/test/terminal-manager.test.ts packages/server/test/transport.terminal-ws.test.ts
```

Expected: PASS, including compatibility and replay order through the real WebSocket route.

- [ ] **Step 7: Commit transport negotiation**

```bash
git add packages/server/src/transport.ts packages/server/test/transport.terminal-ws.test.ts packages/server/test/helpers/test-server.ts
git commit -m "feat: flow-control terminal websocket output"
```

### Task 5: Advertise flow control and ACK xterm parse completion in the browser socket

**Files:**
- Modify: `packages/web/src/api/client.ts:363-417`
- Modify: `packages/web/src/api/client.test.ts:1-4,669-708`
- Modify: `packages/web/src/ws/terminal-socket.ts:35-160`
- Modify: `packages/web/src/ws/terminal-socket.test.ts`

**Interfaces:**
- Consumes: server confirmation `{t:"terminal-flow",v:1,high,low,chunk}`.
- Produces: `TerminalSocketOptions.onData(bytes: Uint8Array, onParsed?: () => void): void` and cumulative `{t:"a",n}` frames bound to one physical socket.

- [ ] **Step 1: Write failing URL capability tests for ticket and token paths**

Import `terminalWsTicketUrl` in `client.test.ts`. Extend the existing legacy URL assertion and add a successful ticket request assertion:

```ts
expect(new URL(terminalWsUrl("s1", 80, 24)).searchParams.get("flow")).toBe("ack-v1");

const ticket = await terminalWsTicketUrl("s1", 80, 24, undefined, {
  baseUrl: "https://node.example",
  getToken: () => "device-token",
  request: vi.fn(async () => new Response(JSON.stringify({ ticket: "one-use" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })),
});
const ticketUrl = new URL(ticket);
expect(ticketUrl.searchParams.get("ticket")).toBe("one-use");
expect(ticketUrl.searchParams.get("flow")).toBe("ack-v1");
expect(ticket).not.toContain("device-token");
```

- [ ] **Step 2: Write failing connection-scoped parse-receipt tests**

Update the test-only `onData` capture to retain the optional callback, then add:

```ts
test("ACKs a binary frame only after its one-shot xterm parse callback", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const parsed: Array<() => void> = [];
  const socket = createTerminalSocket({
    url: "u",
    onData: (_bytes, onParsed) => parsed.push(onParsed!),
  });
  FakeWS.last.open();
  FakeWS.last.onmessage?.({ data: JSON.stringify({ t: "terminal-flow", v: 1, high: 262144, low: 65536, chunk: 65536 }) });
  FakeWS.last.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
  expect(FakeWS.last.sent.map(JSON.parse)).not.toContainEqual({ t: "a", n: 3 });

  parsed[0]!();
  parsed[0]!();
  expect(FakeWS.last.sent.map(JSON.parse).filter((frame) => frame.t === "a")).toEqual([{ t: "a", n: 3 }]);
  FakeWS.last.onmessage?.({ data: new Uint8Array([4, 5]).buffer });
  parsed[1]!();
  expect(FakeWS.last.sent.map(JSON.parse).filter((frame) => frame.t === "a")).toEqual([
    { t: "a", n: 3 },
    { t: "a", n: 5 },
  ]);
  socket.close();
});

test("a stale parse callback cannot ACK the replacement WebSocket", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  let staleParsed: (() => void) | undefined;
  const socket = createTerminalSocket({ url: "u", onData: (_bytes, done) => void (staleParsed = done) });
  const first = FakeWS.last;
  first.open();
  first.onmessage?.({ data: JSON.stringify({ t: "terminal-flow", v: 1, high: 262144, low: 65536, chunk: 65536 }) });
  first.onmessage?.({ data: new Uint8Array([1]).buffer });
  socket.reconnect();
  const second = FakeWS.last;
  second.open();
  staleParsed?.();
  expect(second.sent.map(JSON.parse).some((frame) => frame.t === "a")).toBe(false);
});

test("input remains immediately sendable while an output parse receipt is pending", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  let parsed: (() => void) | undefined;
  const socket = createTerminalSocket({ url: "u", onData: (_bytes, done) => void (parsed = done) });
  FakeWS.last.open();
  FakeWS.last.onmessage?.({
    data: JSON.stringify({ t: "terminal-flow", v: 1, high: 262144, low: 65536, chunk: 65536 }),
  });
  FakeWS.last.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });

  socket.sendInput("x");
  const beforeParse = FakeWS.last.sent.map(JSON.parse);
  expect(beforeParse).toContainEqual({ t: "i", d: "x" });
  expect(beforeParse.some((frame) => frame.t === "a")).toBe(false);
  parsed?.();
  expect(FakeWS.last.sent.map(JSON.parse)).toContainEqual({ t: "a", n: 3 });
});

test("an old server that never confirms flow remains functional and receives no ACK", () => {
  vi.stubGlobal("WebSocket", FakeWS as never);
  const socket = createTerminalSocket({ url: "u", onData: (_bytes, done) => done?.() });
  FakeWS.last.open();
  FakeWS.last.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
  socket.sendInput("legacy-input");
  const sent = FakeWS.last.sent.map(JSON.parse);
  expect(sent).toContainEqual({ t: "i", d: "legacy-input" });
  expect(sent.some((frame) => frame.t === "a")).toBe(false);
});
```

- [ ] **Step 3: Run client/socket tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/web/src/api/client.test.ts packages/web/src/ws/terminal-socket.test.ts
```

Expected: FAIL because URLs omit the capability and `onData` has no receipt.

- [ ] **Step 4: Advertise `ack-v1` in both URL builders**

Set `flow=ack-v1` in the ticket `URLSearchParams` and in the `extra` record passed to `authQuery`. Preserve optional size/respawn behavior and credential placement.

```ts
const params = new URLSearchParams({ ticket: body.ticket, flow: "ack-v1" });
const extra: Record<string, string> = { flow: "ack-v1" };
```

- [ ] **Step 5: Implement confirmation parsing and one-shot connection receipts**

Change the option signature to:

```ts
onData: (bytes: Uint8Array, onParsed?: () => void) => void;
```

Inside each `open(url)` call, keep `let flowEnabled = false` and `let parsedBytes = 0`. Consume only a valid version-1 `terminal-flow` text control. For every binary frame, create a closure that captures `sock`, byte length, and a local `completed` boolean. On first completion, require `ws === sock`, an open socket, and `flowEnabled`; then increment and send the cumulative ACK. Non-flow text controls still reach `onControl` unchanged.

- [ ] **Step 6: Run browser client/socket tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/web/src/api/client.test.ts packages/web/src/ws/terminal-socket.test.ts
```

Expected: PASS with cumulative, one-shot, stale-connection-safe ACKs and immediate input.

- [ ] **Step 7: Commit browser negotiation and ACKs**

```bash
git add packages/web/src/api/client.ts packages/web/src/api/client.test.ts packages/web/src/ws/terminal-socket.ts packages/web/src/ws/terminal-socket.test.ts
git commit -m "feat: acknowledge parsed terminal output"
```

### Task 6: Track every replay frame until xterm parses it

**Files:**
- Modify: `packages/web/src/chat/terminal-output.ts:25-57`
- Modify: `packages/web/src/chat/terminal-output.test.ts:44-65`
- Modify: `packages/web/src/chat/TerminalView.tsx:667-702,946-1035`
- Modify: `packages/web/src/chat/TerminalView.test.tsx:1715-1749`

**Interfaces:**
- Consumes: Task 5's optional `onParsed` callback and existing `writeTerminalBytes` final-chunk callback.
- Produces: `TerminalReplayGuard.wrapFrame(onParsed?: () => void): () => void`, with generation-safe multi-frame suppression.

- [ ] **Step 1: Replace single-frame guard tests with failing multi-frame and stale-generation tests**

Use manually held callbacks:

```ts
test("suppresses side effects until every replay frame parses but excludes later live frames", () => {
  const guard = new TerminalReplayGuard();
  const firstReceipt = vi.fn();
  const secondReceipt = vi.fn();
  guard.begin();
  const first = guard.wrapFrame(firstReceipt);
  const second = guard.wrapFrame(secondReceipt);
  guard.end();
  const liveReceipt = vi.fn();
  const live = guard.wrapFrame(liveReceipt);

  live();
  expect(liveReceipt).toHaveBeenCalledOnce();
  expect(guard.suppressSideEffects).toBe(true);
  first();
  first();
  expect(firstReceipt).toHaveBeenCalledOnce();
  expect(guard.suppressSideEffects).toBe(true);
  second();
  expect(secondReceipt).toHaveBeenCalledOnce();
  expect(guard.suppressSideEffects).toBe(false);
});

test("a callback from a reset connection cannot release a new replay", () => {
  const guard = new TerminalReplayGuard();
  guard.begin();
  const stale = guard.wrapFrame();
  guard.reset();
  guard.begin();
  const current = guard.wrapFrame();
  guard.end();
  stale();
  expect(guard.suppressSideEffects).toBe(true);
  current();
  expect(guard.suppressSideEffects).toBe(false);
});
```

Keep the existing empty-replay assertion: `begin(); end()` must release suppression immediately and a later live frame must not become replay-owned.

- [ ] **Step 2: Run terminal-output tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/web/src/chat/terminal-output.test.ts
```

Expected: FAIL because `wrapFrame` and multi-frame accounting do not exist.

- [ ] **Step 3: Implement generation-safe replay accounting**

Replace `active/awaitingFrame` with `receivingReplay`, `suppressingSideEffects`, `pendingReplayFrames`, and `generation`. `begin()` increments the generation and starts both states. `end()` stops classifying frames and releases suppression only at zero pending frames. `reset()` increments the generation and clears all state.

`wrapFrame` always returns a one-shot callback, always invokes the supplied socket receipt once, and decrements replay accounting only when the captured frame belonged to the current generation:

```ts
wrapFrame(onParsed?: () => void): () => void {
  const replayFrame = this.receivingReplay;
  const generation = this.generation;
  if (replayFrame) this.pendingReplayFrames += 1;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    if (replayFrame && generation === this.generation) {
      this.pendingReplayFrames -= 1;
      if (!this.receivingReplay && this.pendingReplayFrames === 0) this.suppressingSideEffects = false;
    }
    onParsed?.();
  };
}
```

- [ ] **Step 4: Wire the socket receipt through `TerminalView` and strengthen its replay test**

Change the data handler to:

```ts
onData: (bytes, onParsed) => {
  if (disposed) return;
  writeTerminalBytes(term, bytes, replayGuard.wrapFrame(onParsed));
},
```

Update the TerminalView test socket type to capture `(bytes, onParsed)`. Add `let holdTerminalWrites = false` and `const heldTerminalWrites: Array<() => void> = []` beside the existing mock globals, and change the mock adapter's write tail to:

```ts
if (!callback) return;
if (holdTerminalWrites) heldTerminalWrites.push(callback);
else callback();
```

Strengthen the replay test with two held frames and exact receipts:

```ts
holdTerminalWrites = true;
const firstReceipt = vi.fn();
const secondReceipt = vi.fn();
act(() => {
  control?.(JSON.stringify({ t: "terminal-replay", phase: "begin" }));
  onClipboardWrite?.("historical secret");
  socketData?.(new TextEncoder().encode("history-one"), firstReceipt);
  socketData?.(new TextEncoder().encode("history-two"), secondReceipt);
  control?.(JSON.stringify({ t: "terminal-replay", phase: "end" }));
  onClipboardWrite?.("still historical");
});
expect(writeText).not.toHaveBeenCalled();

act(() => heldTerminalWrites.shift()?.());
expect(firstReceipt).toHaveBeenCalledOnce();
expect(secondReceipt).not.toHaveBeenCalled();
act(() => onClipboardWrite?.("still blocked"));
expect(writeText).not.toHaveBeenCalled();

act(() => heldTerminalWrites.shift()?.());
expect(secondReceipt).toHaveBeenCalledOnce();
act(() => onClipboardWrite?.("current selection"));
await waitFor(() => expect(writeText).toHaveBeenCalledWith("current selection"));
holdTerminalWrites = false;
```

Reset `holdTerminalWrites` and `heldTerminalWrites` in the existing test cleanup so one failed assertion cannot poison later TerminalView tests.

- [ ] **Step 5: Run output and TerminalView tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/web/src/chat/terminal-output.test.ts packages/web/src/chat/TerminalView.test.tsx
```

Expected: PASS with replay side effects suppressed through the last parsed replay frame.

- [ ] **Step 6: Commit multi-frame replay safety**

```bash
git add packages/web/src/chat/terminal-output.ts packages/web/src/chat/terminal-output.test.ts packages/web/src/chat/TerminalView.tsx packages/web/src/chat/TerminalView.test.tsx
git commit -m "fix: guard streamed terminal replay frames"
```

### Task 7: Coalesce browser fitting and send only stable dimensions

**Files:**
- Create: `packages/web/src/chat/terminal-resize.ts`
- Create: `packages/web/src/chat/terminal-resize.test.ts`
- Modify: `packages/web/src/chat/xterm-terminal.ts:200-257`
- Modify: `packages/web/src/chat/TerminalView.tsx:335-343,704-709,911-976,1039-1087,1195-1226`
- Modify: `packages/web/src/chat/TerminalView.test.tsx` xterm mock and focused resize tests

**Interfaces:**
- Consumes: an xterm target with `cols`, `rows`, `proposeDimensions()`, and `fitPreservingViewport()` plus a `(cols, rows) => void` sender.
- Produces: `fitTerminalPreservingViewport(target)`, plus `TerminalResizeCoordinator.request()`, `fitNow()`, `connectionOpened()`, and `dispose()`.

- [ ] **Step 1: Write failing deterministic coordinator tests**

Use fake animation frames and fake timers:

```ts
import { expect, test, vi } from "vitest";
import { fitTerminalPreservingViewport, TerminalResizeCoordinator } from "./terminal-resize";

function resizeFixture() {
  let proposed = { cols: 80, rows: 24 };
  const target = {
    cols: 80,
    rows: 24,
    proposeDimensions: () => proposed,
    fitPreservingViewport: vi.fn(() => {
      target.cols = proposed.cols;
      target.rows = proposed.rows;
    }),
  };
  const sent: Array<[number, number]> = [];
  const frames: FrameRequestCallback[] = [];
  const coordinator = new TerminalResizeCoordinator(target, (cols, rows) => sent.push([cols, rows]), {
    requestFrame: (callback) => (frames.push(callback), frames.length),
    cancelFrame: vi.fn(),
  });
  return { target, sent, frames, coordinator, setProposed: (cols: number, rows: number) => void (proposed = { cols, rows }) };
}

test("coalesces unchanged requests without fitting or sending", () => {
  vi.useFakeTimers();
  const { coordinator, target, frames, sent } = resizeFixture();
  coordinator.request();
  coordinator.request();
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  vi.advanceTimersByTime(80);
  expect(target.fitPreservingViewport).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

test("sends only the final dimensions after an 80 ms burst", () => {
  vi.useFakeTimers();
  const { coordinator, frames, sent, setProposed } = resizeFixture();
  coordinator.connectionOpened();
  expect(sent).toEqual([[80, 24]]);
  setProposed(90, 28); coordinator.request(); frames.shift()!(0);
  vi.advanceTimersByTime(40);
  setProposed(100, 30); coordinator.request(); frames.shift()!(16);
  vi.advanceTimersByTime(79);
  expect(sent).toEqual([[80, 24]]);
  vi.advanceTimersByTime(1);
  expect(sent).toEqual([[80, 24], [100, 30]]);
});

test("forces one current-size send on every physical connection", () => {
  const { coordinator, sent } = resizeFixture();
  coordinator.connectionOpened();
  coordinator.connectionOpened();
  expect(sent).toEqual([[80, 24], [80, 24]]);
});

test("restores a deliberately scrolled normal buffer after fit but leaves bottom and alternate buffers alone", () => {
  const active: { type: "normal" | "alternate"; viewportY: number; baseY: number } = {
    type: "normal",
    viewportY: 40,
    baseY: 100,
  };
  const scrollToLine = vi.fn();
  fitTerminalPreservingViewport({
    active,
    fit: () => Object.assign(active, { viewportY: 120, baseY: 120 }),
    scrollToLine,
  });
  expect(scrollToLine).toHaveBeenCalledWith(40);

  scrollToLine.mockClear();
  Object.assign(active, { viewportY: 120, baseY: 120 });
  fitTerminalPreservingViewport({ active, fit: () => {}, scrollToLine });
  expect(scrollToLine).not.toHaveBeenCalled();

  active.type = "alternate";
  active.viewportY = 5;
  active.baseY = 10;
  fitTerminalPreservingViewport({ active, fit: () => Object.assign(active, { viewportY: 10 }), scrollToLine });
  expect(scrollToLine).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run resize tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/web/src/chat/terminal-resize.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the coordinator with an explicit target contract**

Export:

```ts
export interface TerminalResizeTarget {
  readonly cols: number;
  readonly rows: number;
  proposeDimensions(): { cols: number; rows: number } | undefined;
  fitPreservingViewport(): void;
}

export interface TerminalResizeScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export function fitTerminalPreservingViewport(target: {
  active: { type: "normal" | "alternate"; viewportY: number; baseY: number };
  fit(): void;
  scrollToLine(line: number): void;
}): void;

export class TerminalResizeCoordinator {
  constructor(target: TerminalResizeTarget, send: (cols: number, rows: number) => void, scheduler?: Partial<TerminalResizeScheduler>);
  request(): void;
  fitNow(): boolean;
  connectionOpened(): void;
  dispose(): void;
}
```

`fitTerminalPreservingViewport` captures `viewportY` only when the pre-fit buffer is normal and above `baseY`, runs `fit()` once, and then calls `scrollToLine(Math.min(savedViewport, active.baseY))` only if the post-fit buffer is still normal.

`fitNow()` returns false only for missing/non-positive proposals and returns true for every valid measurable proposal, including an unchanged pair. It skips `fitPreservingViewport()` when proposal equals current dimensions. Before the first `connectionOpened()` it performs local fitting without scheduling a remote send. After a changed fit on an open connection, it replaces one 80 ms timer only when the resulting dimensions changed. `connectionOpened()` resets per-connection dedupe and sends the current pair immediately. `dispose()` cancels one pending frame and timer.

- [ ] **Step 4: Expose proposed dimensions and preserve a scrolled viewport in the xterm adapter**

Add:

```ts
proposeDimensions(): { cols: number; rows: number } | undefined {
  const proposed = this.fitAddon.proposeDimensions();
  return proposed ? { cols: proposed.cols, rows: proposed.rows } : undefined;
}

fitPreservingViewport(): void {
  fitTerminalPreservingViewport({
    active: this.terminal.buffer.active,
    fit: () => this.fitAddon.fit(),
    scrollToLine: (line) => this.terminal.scrollToLine(line),
  });
}
```

Keep `fit()` only if another existing caller still uses it after TerminalView migration; otherwise remove it.

- [ ] **Step 5: Replace direct refit/send calls in TerminalView**

Construct one coordinator beside the terminal. Set `refitRef.current = () => resizeCoordinator.request()`. Use `fitNow()` before the first connection so URL dimensions are authoritative. Call `connectionOpened()` in every `onStatus("open")` branch after reset. Change `tick` to request a coalesced fit after connection, and dispose the coordinator in effect cleanup.

Do not call `sock.sendResize` anywhere else in TerminalView.

- [ ] **Step 6: Extend the TerminalView mock and assert reconnect/observer behavior**

Give the mocked `XtermTerminal` `proposeDimensions()` and `fitPreservingViewport()` methods plus counters. Capture `sendResize` calls from the injected socket. Assert one send on each `onStatus("open")`, zero duplicates from repeated observer/font requests at unchanged dimensions, and one final pair after advancing fake timers through a changing proposal burst.

- [ ] **Step 7: Run resize, TerminalView, and manager tests and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/web/src/chat/terminal-resize.test.ts packages/web/src/chat/TerminalView.test.tsx packages/server/test/terminal-manager.test.ts
```

Expected: PASS with client and server dedupe aligned and no scroll-to-bottom regression.

- [ ] **Step 8: Commit resize stabilization**

```bash
git add packages/web/src/chat/terminal-resize.ts packages/web/src/chat/terminal-resize.test.ts packages/web/src/chat/xterm-terminal.ts packages/web/src/chat/TerminalView.tsx packages/web/src/chat/TerminalView.test.tsx
git commit -m "fix: stabilize browser terminal resizing"
```

### Task 8: Add guarded lazy WebGL acceleration

**Files:**
- Create: `packages/web/src/chat/terminal-renderer.ts`
- Create: `packages/web/src/chat/terminal-renderer.test.ts`
- Modify: `packages/web/src/chat/xterm-terminal.ts:110-198,333-338`
- Modify: `packages/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: xterm's `loadAddon`, dynamic `@xterm/addon-webgl` import, and a WebGL renderer probe.
- Produces: `startTerminalRenderer(host, deps?): Promise<TerminalRendererHandle>` where DOM fallback is always a successful result.

- [ ] **Step 1: Write failing renderer-controller tests with injected probes/imports**

Create tests for hardware activation, known software skip, construction/load failure, and context loss:

```ts
import { expect, test, vi } from "vitest";
import { startTerminalRenderer } from "./terminal-renderer";

test("loads hardware WebGL and disposes it on context loss", async () => {
  let loseContext!: () => void;
  const addon = { dispose: vi.fn(), onContextLoss: (cb: () => void) => (loseContext = cb, { dispose: vi.fn() }) };
  const host = { loadAddon: vi.fn() };
  const handle = await startTerminalRenderer(host, {
    probe: () => ({ supported: true, renderer: "Apple M-series" }),
    load: async () => ({ WebglAddon: class { constructor() { return addon; } } as never }),
  });
  expect(host.loadAddon).toHaveBeenCalledWith(addon);
  expect(handle.renderer).toBe("webgl");
  const changes: string[] = [];
  const subscription = handle.onRendererChange((renderer) => changes.push(renderer));
  expect(changes).toEqual(["webgl"]);
  loseContext();
  expect(addon.dispose).toHaveBeenCalledOnce();
  expect(handle.renderer).toBe("dom");
  expect(changes).toEqual(["webgl", "dom"]);
  subscription.dispose();
});

test.each(["Google SwiftShader", "llvmpipe (LLVM 18)"])("keeps DOM for software renderer %s", async (renderer) => {
  const load = vi.fn();
  const handle = await startTerminalRenderer({ loadAddon: vi.fn() }, {
    probe: () => ({ supported: true, renderer }),
    load,
  });
  expect(handle.renderer).toBe("dom");
  expect(load).not.toHaveBeenCalled();
});

test("keeps DOM when probing, importing, constructing, or loading fails", async () => {
  const host = { loadAddon: vi.fn(() => { throw new Error("load failed"); }) };
  const handle = await startTerminalRenderer(host, {
    probe: () => ({ supported: true, renderer: "hardware" }),
    load: async () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } as never }),
  });
  expect(handle.renderer).toBe("dom");
});
```

- [ ] **Step 2: Run renderer tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/web/src/chat/terminal-renderer.test.ts
```

Expected: FAIL because the controller file is absent.

- [ ] **Step 3: Add the compatible addon dependency**

Run:

```bash
pnpm --filter @roamcode.ai/web add @xterm/addon-webgl@^0.19.0
```

Expected: only `packages/web/package.json` and `pnpm-lock.yaml` change; all package versions remain `4.0.47`.

- [ ] **Step 4: Implement the hardware probe and failure-safe controller**

Export these contracts:

```ts
import type { ITerminalAddon } from "@xterm/xterm";

export interface TerminalRendererHandle {
  readonly renderer: "dom" | "webgl";
  onRendererChange(listener: (renderer: "dom" | "webgl") => void): { dispose(): void };
  dispose(): void;
}

export interface TerminalAddonHost {
  loadAddon(addon: ITerminalAddon): void;
}

export interface TerminalRendererDeps {
  probe(): { supported: boolean; renderer?: string };
  load(): Promise<typeof import("@xterm/addon-webgl")>;
}

export async function startTerminalRenderer(
  host: TerminalAddonHost,
  deps?: Partial<TerminalRendererDeps>,
): Promise<TerminalRendererHandle>;
```

The default probe creates a temporary canvas, tries `webgl2` then `webgl`, reads `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL` when available and `gl.RENDERER` otherwise, and loses the temporary context when supported. Reject `/swiftshader|llvmpipe|software rasterizer/iu`. Catch probe/import/construction/load failures and return a no-op DOM handle. `onRendererChange` immediately reports the current renderer and then reports transitions. On addon context loss, dispose the listener and addon once and notify `"dom"`.

- [ ] **Step 5: Start rendering lazily from the xterm adapter**

After `terminal.open(host)`, set the host's dev-observable `data-terminal-renderer` to `dom` and invoke the controller without awaiting it:

```ts
void startTerminalRenderer(this.terminal).then((handle) => {
  if (this.disposed) {
    handle.dispose();
    return;
  }
  this.rendererHandle = handle;
  this.rendererSubscription = handle.onRendererChange((renderer) => {
    this.host.dataset.terminalRenderer = renderer;
  });
});
```

Track `disposed`, `rendererHandle`, and `rendererSubscription`. Dispose the subscription and handle before the terminal, and remove the dataset during adapter cleanup. Context loss must not reset xterm or touch the socket.

- [ ] **Step 6: Run renderer tests, type checking, and web build**

Run:

```bash
pnpm exec vitest run packages/web/src/chat/terminal-renderer.test.ts packages/web/src/chat/TerminalView.test.tsx
pnpm --filter @roamcode.ai/web typecheck
pnpm --filter @roamcode.ai/web build
```

Expected: all commands exit zero; Vite emits WebGL as a lazy chunk rather than blocking the main terminal chunk.

- [ ] **Step 7: Commit guarded acceleration**

```bash
git add packages/web/src/chat/terminal-renderer.ts packages/web/src/chat/terminal-renderer.test.ts packages/web/src/chat/xterm-terminal.ts packages/web/package.json pnpm-lock.yaml
git commit -m "perf: add guarded terminal WebGL rendering"
```

### Task 9: Add a real-xterm performance and resize contract

**Files:**
- Create: `packages/web/src/screenshot/terminal-performance-harness.ts`
- Create: `packages/web/src/screenshot/terminal-performance-harness.test.ts`
- Modify: `packages/web/src/screenshot/scenes.tsx:28-59`
- Modify: `packages/web/scripts/mobile-smoke.mjs:439-567,1180-1217,1381-1402` and browser setup

**Interfaces:**
- Consumes: the same `(bytes, onParsed)` callback used by the production terminal view.
- Produces: a dev-only bounded output pump with `push`, `armEcho`, `sendInput`, `recordResize`, `resetMetrics`, `snapshot`, and `close`; browser measurements for input-send latency, maximum unparsed bytes, echo paint latency, order, frame gaps, long tasks, and remote resize count.

- [ ] **Step 1: Write failing harness window/order tests**

Define the expected public surface in a unit test:

```ts
const receipts: Array<() => void> = [];
const delivered: Uint8Array[] = [];
const harness = new ScreenshotTerminalPerformanceHarness((bytes, parsed) => {
  delivered.push(bytes);
  receipts.push(parsed);
});

const output = harness.push("x".repeat(300_000));
expect(delivered.map((frame) => frame.byteLength)).toEqual([65536, 65536, 65536, 65536]);
expect(harness.snapshot().maxUnparsedBytes).toBe(262144);
receipts.shift()!();
expect(delivered.at(-1)?.byteLength).toBe(37_856);
await Promise.all(receipts.splice(0).map(async (receipt) => receipt()));
await output;
expect(harness.snapshot().parsedBytes).toBe(300_000);
```

Add the priority/order test with concrete held receipts:

```ts
test("places an input echo after delivered bytes but before synthetic output the paused PTY has not emitted", async () => {
  const receipts: Array<() => void> = [];
  const delivered: Uint8Array[] = [];
  const harness = new ScreenshotTerminalPerformanceHarness((bytes, parsed) => {
    delivered.push(bytes);
    receipts.push(parsed);
  });
  const dense = harness.push("d".repeat(600_000));
  harness.armEcho("RC_ECHO_1", 10);
  harness.sendInput("x");

  expect(delivered).toHaveLength(4);
  receipts.shift()!();
  expect(new TextDecoder().decode(delivered[4])).toContain("RC_ECHO_1");
  while (receipts.length > 0) receipts.shift()!();
  await dense;
  const stats = harness.snapshot();
  expect(stats.parsedFrameIds).toEqual(stats.deliveredFrameIds);
  expect(stats.maxUnparsedBytes).toBeLessThanOrEqual(262_144);
});
```

- [ ] **Step 2: Run the harness test and verify RED**

Run:

```bash
pnpm exec vitest run packages/web/src/screenshot/terminal-performance-harness.test.ts
```

Expected: FAIL because the harness does not exist.

- [ ] **Step 3: Implement the dev-only bounded pump and metrics**

Export:

```ts
export interface TerminalPerformanceSnapshot {
  sentBytes: number;
  parsedBytes: number;
  unparsedBytes: number;
  maxUnparsedBytes: number;
  resizeFrames: Array<[number, number]>;
  inputSendMs: Record<string, number>;
  visibleEchoMs: Record<string, number>;
  deliveredFrameIds: number[];
  parsedFrameIds: number[];
}

export class ScreenshotTerminalPerformanceHarness {
  constructor(deliver: (bytes: Uint8Array, parsed: () => void) => void);
  push(text: string): Promise<void>;
  armEcho(marker: string, startedAt: number): void;
  sendInput(data: string): void;
  recordResize(cols: number, rows: number): void;
  resetMetrics(): void;
  snapshot(): TerminalPerformanceSnapshot;
  close(): void;
}
```

Import `TERMINAL_WRITE_CHUNK_BYTES`, use it as the 64 KiB frame limit, and derive the 256 KiB in-flight window as four chunks. Normal output enters the tail queue. An armed echo enters immediately after already delivered frames and before unsent synthetic producer output, modeling bytes the paused PTY has not emitted yet. When `sendInput` consumes an armed marker, record `inputSendMs[marker]` from the supplied start time. Complete `visibleEchoMs[marker]` after the echo's parse callback and two animation frames. `push()` resolves only when all of its bytes parse. `resetMetrics()` throws `Error("cannot reset terminal performance metrics while output is in flight")` when unparsed bytes remain and otherwise clears counters without replacing the harness. `close()` resolves retained `push()` promises, clears the queues, and prevents later delivery.

- [ ] **Step 4: Replace the screenshot socket's unbounded one-frame injection**

Extend its local audit type with:

```ts
__rcScreenshotOutput?: (data: string) => Promise<void>;
__rcTerminalPerformance?: {
  armEcho(marker: string, startedAt: number): void;
  snapshot(): TerminalPerformanceSnapshot;
  resetMetrics(): void;
};
```

Create one harness per mock socket. Route initial ANSI capture and `__rcScreenshotOutput` through `push`, route `sendInput` through the existing input array and `harness.sendInput`, and route `sendResize` to `recordResize`. Remove only globals owned by that harness on close. Keep the screenshot module absent from the production entrypoint.

- [ ] **Step 5: Replace DOM-only renderer assertions with DOM-or-hardware assertions**

In both desktop and keyboard viewport checks, compute:

```js
const renderer = {
  kind: screen.querySelectorAll("canvas").length > 0 ? "webgl" : "dom",
  canvasCount: screen.querySelectorAll("canvas").length,
  rowCount: rows?.children.length ?? 0,
  screenWidth: screen.getBoundingClientRect().width,
};
assert(renderer.screenWidth > 0, `${browserName}: terminal renderer has no painted surface`);
assert(
  renderer.kind === "webgl" ? renderer.canvasCount > 0 : renderer.rowCount > 0,
  `${browserName}: neither hardware WebGL nor DOM rendered the terminal`,
);
```

Keep the existing box-line text assertion only on the DOM branch; a canvas branch is proven by its non-zero surface plus the xterm buffer-state checks.

- [ ] **Step 6: Add desktop and Pixel 7/4x CPU dense-output probes**

Add `exerciseTerminalPerformance(browser, baseUrl)` for Chromium. Run five echo samples on a 1280x800 desktop context and five on a Pixel 7 context. For the Pixel page, create a CDP session and send:

```js
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
```

For each sample, reset metrics, start an animation-frame gap recorder and a `PerformanceObserver` for `longtask`, enqueue roughly 4 MiB across 20,000 ordered rows, arm a unique echo marker immediately before dispatch, focus xterm input, dispatch one key, and wait for `visibleEchoMs[marker]`. Stop both observers after parsing completes. Compute p95 for input-send and visible-echo latency, plus the maximum frame gap and long-task duration. Assert for every run:

```js
assert.equal(stats.maxUnparsedBytes <= 256 * 1024, true, "xterm parse window exceeded 256 KiB");
assert.equal(stats.sentBytes, stats.parsedBytes, "terminal bytes were not fully parsed");
assert.deepEqual(stats.parsedFrameIds, stats.deliveredFrameIds, "terminal output parse order changed");
assert(inputSendP95 < 100, `terminal input did not reach the mock socket promptly: ${inputSendP95}ms`);
assert(p95 < 1_500, `terminal visible echo exceeded the conservative smoke ceiling: ${p95}ms`);
if (process.env.RC_TERMINAL_PERF_STRICT === "1") {
  assert(p95 < targetMs, `terminal visible echo missed the product target: ${p95}ms >= ${targetMs}ms`);
}
```

Use `targetMs=100` for desktop and `targetMs=150` for Pixel 7/4x. Print one `TERMINAL_PERF` JSON line containing input-send p95, visible-echo p95, max unparsed bytes, maximum animation-frame gap, long-task count and maximum duration, resize count, and renderer kind for both profiles.

- [ ] **Step 7: Add the synthetic resize-burst assertion**

On the dedicated performance page, reset recorded resizes after initial open. Change the terminal stage width three times across consecutive animation frames, wait 160 ms, and assert exactly one remote resize with the final dimensions. Wait another 100 ms and assert no duplicate appears.

- [ ] **Step 8: Run harness unit and real-browser smoke tests**

Run:

```bash
pnpm exec vitest run packages/web/src/screenshot/terminal-performance-harness.test.ts
RC_MOBILE_CHROMIUM=bundled pnpm --filter @roamcode.ai/web test:mobile
```

Expected: unit tests pass; browser smoke reports ordered output, at most 262144 unparsed bytes, one final resize, a functioning DOM or hardware renderer, and echo p95 under the conservative ceiling.

- [ ] **Step 9: Run and record the strict product-target profile**

Run:

```bash
RC_MOBILE_CHROMIUM=bundled RC_TERMINAL_PERF_STRICT=1 pnpm --filter @roamcode.ai/web test:mobile
```

Expected: desktop p95 is below 100 ms and Pixel 7/4x p95 is below 150 ms. Retain the `TERMINAL_PERF` line in the implementation handoff; do not add machine-specific timings or paths to the repository.

- [ ] **Step 10: Commit the browser performance contract**

```bash
git add packages/web/src/screenshot/terminal-performance-harness.ts packages/web/src/screenshot/terminal-performance-harness.test.ts packages/web/src/screenshot/scenes.tsx packages/web/scripts/mobile-smoke.mjs
git commit -m "test: enforce browser terminal performance contract"
```

### Task 10: Add the user-facing fix note and run the complete scoped gate

**Files:**
- Modify: `CHANGELOG.md:7`
- Verify: all files changed by Tasks 1-9
- Preserve unstaged: unrelated user-owned files, including `design-qa.md`

**Interfaces:**
- Consumes: all preceding task commits and the approved design spec.
- Produces: one accurate `Unreleased` note and evidence that the implementation is ready for review without publishing it.

- [ ] **Step 1: Add the exact user-facing changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Fixed

- Keep terminal typing responsive during heavy agent output and keep the screen stable across desktop and mobile
  viewport changes. Browser parsing now applies real backpressure, repeated PTY resizes are deduplicated, and a
  reconnect redraw no longer changes the terminal height temporarily.
```

- [ ] **Step 2: Run formatting and inspect only intended changes**

Run:

```bash
pnpm exec prettier --write \
  packages/server/src/terminal-flow.ts \
  packages/server/test/terminal-flow.test.ts \
  packages/server/src/terminal-process.ts \
  packages/server/test/terminal-process.test.ts \
  packages/server/src/terminal-manager.ts \
  packages/server/test/terminal-manager.test.ts \
  packages/server/src/transport.ts \
  packages/server/test/transport.terminal-ws.test.ts \
  packages/server/test/helpers/test-server.ts \
  packages/web/src/api/client.ts \
  packages/web/src/api/client.test.ts \
  packages/web/src/ws/terminal-socket.ts \
  packages/web/src/ws/terminal-socket.test.ts \
  packages/web/src/chat/terminal-output.ts \
  packages/web/src/chat/terminal-output.test.ts \
  packages/web/src/chat/terminal-resize.ts \
  packages/web/src/chat/terminal-resize.test.ts \
  packages/web/src/chat/terminal-renderer.ts \
  packages/web/src/chat/terminal-renderer.test.ts \
  packages/web/src/chat/xterm-terminal.ts \
  packages/web/src/chat/TerminalView.tsx \
  packages/web/src/chat/TerminalView.test.tsx \
  packages/web/src/screenshot/terminal-performance-harness.ts \
  packages/web/src/screenshot/terminal-performance-harness.test.ts \
  packages/web/src/screenshot/scenes.tsx \
  packages/web/scripts/mobile-smoke.mjs \
  packages/web/package.json \
  CHANGELOG.md
git diff --check
git status --short
```

Expected: no whitespace errors; `design-qa.md` remains unstaged and unchanged by this work.

- [ ] **Step 3: Run the deterministic focused suites**

Run:

```bash
pnpm exec vitest run \
  packages/server/test/terminal-flow.test.ts \
  packages/server/test/terminal-process.test.ts \
  packages/server/test/terminal-manager.test.ts \
  packages/server/test/transport.terminal-ws.test.ts \
  packages/web/src/api/client.test.ts \
  packages/web/src/ws/terminal-socket.test.ts \
  packages/web/src/chat/terminal-output.test.ts \
  packages/web/src/chat/terminal-resize.test.ts \
  packages/web/src/chat/terminal-renderer.test.ts \
  packages/web/src/chat/TerminalView.test.tsx \
  packages/web/src/screenshot/terminal-performance-harness.test.ts
```

Expected: all named files pass.

- [ ] **Step 4: Run repository static and package gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --filter @roamcode.ai/web build
pnpm --filter @roamcode.ai/server build
```

Expected: every command exits zero.

- [ ] **Step 5: Run the isolated browser gate once more on the final source diff**

Run:

```bash
RC_MOBILE_CHROMIUM=bundled pnpm --filter @roamcode.ai/web test:mobile
```

Expected: mobile contracts pass and the `TERMINAL_PERF` report remains within the deterministic window/order/resize limits and conservative timing ceiling.

- [ ] **Step 6: Commit only the changelog after all gates pass**

```bash
git add CHANGELOG.md
git commit -m "docs: note terminal responsiveness improvements"
```

- [ ] **Step 7: Review the final implementation scope without publishing**

Run:

```bash
git status --short --branch
git log --oneline --decorate -12
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: implementation and documentation commits are local, unrelated user changes remain unstaged, and no version, tag, release, push, workflow, service, or OTA mutation has occurred.
