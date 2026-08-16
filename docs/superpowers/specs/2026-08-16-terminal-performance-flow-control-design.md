# Browser terminal performance and stability design

**Date:** 2026-08-16
**Status:** Approved in chat

## Problem

The browser terminal becomes visibly sluggish under dense provider output on both desktop Chrome and Android.
Keystrokes reach the terminal WebSocket quickly, but their visible PTY echo waits behind output already queued in
xterm. The screen can also reflow or redraw repeatedly because every browser fit may send a PTY resize, including
unchanged dimensions and transient sizes produced during viewport, font, and on-screen-keyboard transitions.

The current live-reattach recovery adds another concrete shift: it deliberately resizes the PTY to one extra row
and restores the original size 60 ms later to make tmux repaint. That dimension-changing redraw heuristic must be
removed rather than merely deduplicated.

An isolated benchmark of the current `TerminalView` path with roughly 4 MB of ordered terminal output measured:

- desktop Chrome: about 0.6 ms from key handling to socket input, but about 260 ms to visible echo;
- Pixel 7 emulation with 4x CPU throttling: about 0.4 ms to socket input, but about 499 ms to visible echo;
- maximum main-thread frame gaps of roughly 83 ms and 117 ms respectively;
- no synthetic cumulative layout shift, which points the visible movement toward terminal fit/PTY redraw rather
  than ordinary document layout.

The current browser splits a large WebSocket frame before calling `Terminal.write`, but submits every split chunk
synchronously. xterm's non-blocking write API then owns an unbounded parser backlog. The server limits only the
WebSocket implementation's `bufferedAmount`; it has no signal for bytes that reached the browser but are still
waiting for xterm. The xterm project documents this failure mode and recommends propagating write-completion
acknowledgements back to the PTY producer: <https://xtermjs.org/docs/guides/flowcontrol/>.

The default DOM renderer is also a throughput ceiling. WebGL can improve hardware-backed Chrome rendering, but it
cannot solve parser backpressure and can be slower under software rendering. It must therefore be an optional,
failure-safe accelerator rather than the correctness mechanism.

## Goals

1. Keep keyboard capture, transport, and visible echo responsive while output is sustained.
2. Bound terminal bytes submitted but not yet parsed by xterm.
3. Propagate real browser parser pressure back to the owning PTY without letting a background or dead browser stall
   an agent indefinitely.
4. Preserve terminal byte order, reconnect history, terminal-state handoff, and replay side-effect suppression.
5. Eliminate duplicate and transient remote PTY resizes that cause avoidable reflow and redraw.
6. Use hardware WebGL when it is safe and useful, with automatic DOM fallback.
7. Remain compatible during old-client/new-server and new-client/old-server PWA transitions.

## Non-goals

- Replacing xterm with another terminal engine.
- Predictive local echo, which is incorrect for terminal applications and provider TUIs.
- Dropping or reordering output for a foreground, healthy, flow-controlled viewer.
- Changing provider behavior, tmux history ownership, terminal styling, or existing keyboard semantics.
- Adding a renderer preference UI or a general-purpose transport protocol framework.
- Mutating or restarting an installed RoamCode service as part of development verification.

## Chosen approach

Implement four focused units:

1. a connection-scoped browser output acknowledger;
2. a server-side ordered sender with a bounded byte window;
3. a session-level PTY pressure coordinator across viewers;
4. a browser resize coordinator plus a guarded WebGL renderer controller.

The flow-control protocol is the root fix. Resize stabilization and guarded GPU rendering address the independent
redraw and paint costs without being allowed to weaken terminal correctness.

### Alternatives considered

- **Client-only paced writes:** this would keep xterm's internal queue small, but the browser WebSocket and an
  application queue could still grow without bound. More importantly, a new input echo would remain behind all
  earlier output already delivered to the browser.
- **WebGL-only rendering:** hardware rendering can reduce paint work, but it neither bounds xterm parser input nor
  prevents repeated PTY resize redraws. Software WebGL can also be slower than the DOM renderer.
- **Flow control without renderer or resize work:** this is the conservative fallback if the accelerator proves
  unsafe, but it leaves two measured costs untreated. The chosen design keeps those units independent so WebGL can
  fall back without weakening flow control or resize stabilization.

## Terminal flow-control protocol

### Negotiation

A capable browser adds `flow=ack-v1` to the terminal WebSocket URL. The value is a capability flag, not a
client-selected budget. A supporting server sends this text control frame before terminal replay or live output:

```json
{"t":"terminal-flow","v":1,"high":262144,"low":65536,"chunk":65536}
```

The server owns the fixed values:

- high watermark: 256 KiB of sent but unacknowledged binary output;
- low watermark: 64 KiB;
- maximum binary output frame: 64 KiB.

PTY output remains an ordinary binary WebSocket frame. File and lifecycle controls remain text frames. A browser
acknowledges cumulative parsed binary bytes on that WebSocket connection:

```json
{"t":"a","n":196608}
```

The counter starts at zero for every physical WebSocket connection. The server accepts only finite safe integers
that are monotonic and no greater than the cumulative bytes it sent. Duplicate or lower acknowledgements are
ignored. An acknowledgement beyond sent bytes is a protocol violation and closes that socket through the existing
transient terminal-error path.

### Compatibility

- A new server uses ACK flow control only when the URL advertises `ack-v1`; an old cached client therefore keeps
  the legacy behavior.
- A new client may send ACK messages to an old server. The current message parser safely ignores unknown message
  types, so input, resize, and visibility continue to work.
- Binary output framing is unchanged, so the protocol does not require a coordinated flag-day deployment.

The new-client/old-server combination cannot gain backpressure until the server updates, but it remains functional.

## Browser output acknowledger

Flow accounting belongs in `terminal-socket.ts`, where a physical WebSocket connection is known. Each received
binary frame is delivered to the terminal writer with a one-shot `parsed` completion callback bound to that exact
socket. `TerminalView` calls the completion only after xterm invokes the callback for the final chunk of that frame.

The socket then increments its parsed-byte counter and sends the cumulative ACK. A completion left over from a
closed connection checks its captured socket identity and becomes a no-op; it can never acknowledge bytes on a new
connection. Reconnect initializes fresh sent/parsed counters.

Legacy large frames continue to be split before xterm submission. Under `ack-v1`, the server already sends at most
64 KiB per binary frame, so no more than 256 KiB can be submitted without xterm parse completion. Input remains on
the same full-duplex socket and is never held behind the output ACK window.

## Server ordered sender

Each flow-enabled terminal WebSocket owns an ordered outbound sender. It tracks cumulative binary bytes sent and
acknowledged and sends binary slices only while the unacknowledged total remains at or below 256 KiB. Data is split
without changing UTF-8 bytes or ANSI ordering.

Replay begin/end controls and binary replay data share the ordered sender. This is necessary because the current
replay can be one multi-megabyte value: the `end` marker must not overtake replay bytes retained behind the window.
Other terminal control frames keep their relative order through the same sender. Terminal exit may still close the
socket immediately rather than wait behind an output backlog.

The sender retains at most the existing bounded reconnect replay plus one small live-output tail. If its pending
budget would exceed 16 MiB despite PTY pressure, it closes the socket and relies on the authoritative tmux replay
on reconnect instead of growing process memory without a bound.

### Multi-frame replay guard

The browser replay guard gains distinct `receivingReplay` and `suppressingSideEffects` states:

1. `begin` starts both states.
2. Binary frames received before `end` each register a parse completion with the guard.
3. `end` stops classifying later live frames as replay, but side effects remain suppressed while registered replay
   frames are still waiting in xterm.
4. The final replay parse completion releases suppression.

This preserves OSC clipboard and related safety behavior while allowing replay to be streamed through the bounded
window. An empty replay releases suppression at `end`.

## PTY pressure coordination

`TerminalSub` gains an idempotent output-pressure signal. `TerminalManager` pauses a session's `TerminalProcess`
when any foreground, flow-enabled subscriber is above the high watermark. The installed `node-pty` API already
exposes `pause()` and `resume()`; `TerminalProcess` wraps those operations so manager tests can use an isolated fake.

The manager resumes the PTY only after the sender has flushed its pending tail and unacknowledged bytes are at or
below the low watermark. This hysteresis avoids rapid pause/resume oscillation. Every state transition is
idempotent.

Viewer policy:

- a foreground subscriber participates in pressure coordination;
- a background subscriber never pauses the PTY;
- with multiple foreground subscribers, pressure from any healthy subscriber pauses the shared PTY so each keeps
  complete ordered output;
- a subscriber that makes no ACK progress for five seconds while pressured is closed as stalled, removed from the
  pressure calculation, and allowed to reconnect through bounded replay;
- unsubscribe, abort, socket error, socket close, process exit, and session stop all release that subscriber's
  pressure before cleanup completes.

If a background browser continues to ACK, it may keep receiving. If browser throttling fills its window, the server
does not accumulate unbounded live output or pause the PTY for it. The sender clears that subscriber's unsent queue,
marks `replayOnVisible`, and skips later terminal frames for that subscriber. File controls remain durable in the
manager. On the next `{ "t": "v", "v": true }`, the server closes that socket through the existing transient
reconnect path; the new connection restores terminal state, history, and durable file controls from tmux and the
manager through the same bounded path. Waiting until foreground return prevents a throttled background page from
entering a reconnect loop.

This policy deliberately applies backpressure to a producing agent only while a real foreground viewer needs it.
It prioritizes interactive correctness without allowing a sleeping phone or abandoned tab to govern the session.

## Resize stabilization

Create a small browser resize coordinator around xterm's fit addon:

1. Coalesce resize, font-ready, foreground, and zoom requests to at most one calculation per animation frame.
2. Use proposed terminal dimensions and skip local `fit()` when rows and columns are unchanged.
3. Apply a changed local fit once, then wait for 80 ms without another cell-dimension change before sending the
   remote PTY resize.
4. Deduplicate against the last dimensions sent on that physical connection.
5. Force exactly one current-size send after each connection opens. This is required because the URL dimensions
   size a new process, while a reattach to an existing process still needs an explicit resize.

The server independently clamps the requested dimensions, compares them with the record's current rows and columns,
and returns without calling `TerminalProcess.resize` when they are unchanged. This protects old clients and races
that bypass browser deduplication.

For a live reattach, the server first applies the dimensions from the WebSocket URL to the existing process, before
replay and redraw. It then replaces the current `rows + 1`/restore wiggle with tmux's real client redraw command.
`TerminalProcess` reads the exact slave PTY name exposed by `node-pty` and invokes
`refresh-client -t <pty-name>` on RoamCode's dedicated tmux socket. Upstream tmux calls `server_redraw_client` for
this command when `-S` is absent: <https://github.com/tmux/tmux/blob/master/cmd-refresh-client.c>. If the PTY name
is unavailable, replay and terminal-state seeding remain authoritative; the server does not fall back to a
dimension-changing heuristic.

Local fitting does not force a normal-buffer user back to the bottom when they deliberately scrolled up. Alternate
screen applications receive only the final stable remote resize, avoiding repeated tmux redraws during browser
chrome, soft-keyboard, split-view, or window-resize transitions.

## Guarded WebGL acceleration

Add the xterm WebGL addon as a lazily loaded accelerator after the terminal has opened. Connection establishment
does not wait for the dynamic import.

The renderer controller:

- requires a usable WebGL context;
- skips known software renderers such as SwiftShader or llvmpipe when renderer information is available;
- catches addon import, construction, activation, and load failures;
- disposes the addon on context loss so xterm immediately returns to its DOM renderer;
- never resets the terminal, reconnects the socket, or changes protocol state during fallback.

The DOM renderer remains the universal baseline. WebGL is not considered evidence that flow control can be removed
or its window enlarged.

## Error handling and recovery

- Invalid ACK: close only the offending terminal socket as a transient protocol error.
- ACK stall: after five seconds without progress while pressured, release pressure before closing and reconnecting.
- Socket loss during pause: detach releases pressure synchronously; the session cannot remain paused without a
  subscriber.
- Background overflow: clear that subscriber's pending output, never pause the PTY, and trigger one bounded replay
  reconnect on foreground return.
- Reconnect: reset connection counters and terminal state, then stream replay and live redraw through the negotiated
  window.
- Replay interruption: socket teardown resets the replay guard; the next connection starts from a clean terminal.
- WebGL failure or context loss: dispose the addon and continue on DOM without user-visible connection failure.
- Resize errors: retain current defensive clamping and best-effort PTY behavior; duplicate dimensions are no-ops.

No recovery path may silently reorder bytes, acknowledge unparsed bytes, leave a PTY paused after its subscriber is
gone, or hide a flow stall behind a permanently frozen terminal. Repeated transient reconnect failures continue to
use the existing explicit unreachable status.

## Testing strategy

Implementation follows test-driven development. Tests use fake PTYs or a unique isolated tmux socket and never the
developer's installed service, default RoamCode tmux socket, live sessions, or service data.

### Deterministic browser and protocol tests

- ACK is emitted only after the final xterm write callback for a binary frame.
- ACK counters are cumulative, monotonic, one-shot, and connection-scoped.
- A stale parse callback from a prior WebSocket cannot ACK a new connection.
- Flow negotiation remains compatible in both mixed-version directions.
- Binary data and replay controls retain order across a multi-frame replay.
- Replay side effects remain suppressed until every replay frame is parsed, while later live frames are not counted
  as replay.
- Input remains immediately sendable while the output window is full.

### Deterministic server and PTY tests

- At most 256 KiB is sent without parse ACKs and each binary frame is at most 64 KiB.
- High watermark pauses once; low watermark resumes once; intermediate ACKs do not oscillate.
- Malformed, decreasing, duplicate, and beyond-sent ACKs follow the specified validation behavior.
- A background subscriber cannot pause the PTY.
- Two foreground subscribers preserve ordered output; a stalled one is released after five seconds without leaving
  the other blocked.
- Detach, abort, socket error, close, exit, and stop release pressure.
- Queue memory stays bounded and overflow enters reconnect/replay recovery.

### Resize tests

- Repeated observer events with unchanged proposed rows and columns cause no fit or remote resize.
- A burst of transient cell dimensions produces one final remote resize after stability.
- Reconnect forces one current-size message.
- Server-side clamping happens before comparison and identical clamped dimensions do not call the PTY.
- A live reattach applies the requested size once, targets the exact tmux client for redraw, and never performs a
  transient extra-row resize.
- A user-scrolled normal buffer is not forcibly moved to the bottom.

### Renderer tests

- Hardware-capable WebGL loads without blocking terminal connection.
- Unsupported or known software rendering keeps the DOM renderer.
- Activation failure and context loss dispose WebGL and preserve the live terminal.

### Browser performance contract

Extend the real-xterm isolated Chrome smoke so it injects roughly 4 MB / 20,000 lines, dispatches a key while output
is sustained, immediately echoes that input through the mock transport, and records:

- keydown to socket send;
- keydown to visible echo;
- maximum unacknowledged terminal bytes;
- long tasks and maximum animation-frame gap;
- remote resize count during a synthetic viewport transition.

Product acceptance targets are:

- desktop Chrome visible-echo p95 below 100 ms;
- Pixel 7 emulation with 4x CPU throttling visible-echo p95 below 150 ms;
- no more than 256 KiB of sent but unparsed terminal output;
- no byte loss or ordering failure;
- one remote resize for one stable dimension transition and zero duplicate server PTY resizes.

Shared CI hardware is variable, so protocol window, ordering, pause/resume, and resize counts are the strict
deterministic gates. The browser smoke uses a conservative wall-clock ceiling to catch regressions, while the
100/150 ms product targets are checked through repeated controlled profiling and recorded in the implementation
verification.

## Expected code boundaries

- `packages/web/src/ws/terminal-socket.ts`: capability query, per-connection parse receipts, cumulative ACKs.
- `packages/web/src/chat/terminal-output.ts`: parsed-frame completion and multi-frame replay guard.
- `packages/web/src/chat/TerminalView.tsx`: wire output receipts, resize coordinator, and renderer controller.
- a focused web resize/renderer helper rather than adding more policy directly to `TerminalView`.
- `packages/server/src/transport.ts`: negotiate flow control, validate ACKs, and own the ordered per-socket sender.
- a focused server flow-window helper so transport routing remains readable and independently testable.
- `packages/server/src/terminal-manager.ts`: foreground subscriber pressure aggregation and duplicate resize no-op.
- `packages/server/src/terminal-process.ts`: injectable, idempotent PTY pause/resume wrapper and exact-client tmux
  redraw operation.
- focused unit tests beside the existing socket, terminal output, manager, transport, and browser smoke coverage.

Names may follow established repository naming during implementation, but the responsibilities and boundaries above
are fixed. No unrelated `TerminalView`, transport, provider, or visual redesign is part of this work.

## Delivery boundary

This design authorizes implementation and isolated verification after the written spec is reviewed. It does not
authorize a version bump, release commit, push, workflow dispatch, service restart, OTA activation, or publication.
Those remain separate explicit user actions under the stable release contract.
