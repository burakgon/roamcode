# Terminal-mode sessions (claude TUI via tmux + node-pty) — design

**Status:** approved design, pending spec review
**Date:** 2026-06-30
**Author:** brainstormed with the maintainer

## Summary

Add a second kind of session — a **terminal session** — that runs the real `claude`
interactive TUI in a server-side PTY and renders it in the browser with xterm.js. The
existing structured **chat session** (stream-json → custom UI) is unchanged. The user picks
the kind when creating a session; the kind is **fixed for the session's life** (v1).

The goal, in the maintainer's words: "use Claude Code with all its features" — the native TUI
exposes flows the headless stream-json path doesn't (its own permission UI, slash commands,
plan mode, etc.). A terminal session is the way to reach those from the phone/desktop PWA.

Persistence is delegated to **tmux**: the TUI runs inside a detached tmux session, so it
survives client disconnects AND server (OTA) restarts. node-pty bridges the tmux client's PTY
to a binary WebSocket. The server is a thin byte-bridge; tmux owns scrollback, redraw, resize.

## Non-goals (v1)

- **No in-session Chat↔Terminal toggle / handoff.** Mode is chosen once at creation. (A single
  `claude` process cannot be both stream-json and an interactive TUI at once; a live handoff
  would mean stop-one/`--resume`-the-other each way. Deferred — the resume path already exists
  if we revisit it.)
- **No general-purpose shell features framing.** The terminal launches `claude` directly, not a
  bare shell. (The user explicitly wants only the claude TUI here. A user can still drop to a
  shell from within claude if claude allows it; we don't build shell-specific UX.)
- **No reconciliation of our session id with claude's own transcript id.** Our id is the handle
  (tmux session name `rc-<id>` + db row). The TUI writes its own transcript under
  `~/.claude/projects/...` as usual; we don't render it in our UI for terminal sessions.

## Core model

A session gains a `mode` field: `"chat"` (today) | `"terminal"` (claude TUI). Chosen in the
new-session wizard; persisted; fixed for the session's life.

- **Chat session:** unchanged — `ClaudeProcess` (stream-json), custom chat UI.
- **Terminal session:** `claude` TUI in a tmux+PTY, rendered by xterm.js. cwd comes from the
  same wizard directory picker; the wizard's model / permission-mode choices are passed to
  `claude` as flags where applicable.

The session list shows both kinds in one list, terminal sessions marked with a terminal glyph
and a live/ended state. Selecting a terminal session opens the xterm view; chat sessions open
the chat view as today. There is no per-session mode tab (that was the deferred handoff).

## Server architecture

### Data model
- `sessions.db`: additive column `mode TEXT NOT NULL DEFAULT 'chat'`, applied in the
  session-store init (additive, default-valued — back-compatible with existing rows).

### `terminal-process.ts` (new) — the PTY/tmux bridge
Analogous to `claude-process.ts`, but wraps node-pty over tmux. One instance per *connected*
terminal session.

- **start(cols, rows):** `pty.spawn("tmux", ["new-session", "-A", "-s", "rc-<id>", "--",
  claudeBin, ...claudeFlags], { name: "xterm-256color", cwd, env, cols, rows })`.
  - `-A` = attach-if-exists-else-create, so first open creates+runs claude and a reconnect
    attaches the live one (idempotent).
  - Immediately best-effort `tmux set-option -t rc-<id> remain-on-exit on` so claude exiting
    leaves a "[exited]" pane (restartable) instead of destroying the session.
  - `ANTHROPIC_API_KEY` deleted from the child env (subscription auth only), mirroring
    `claude-process.ts`.
- **Events:** `data` (Buffer → fan out to subscribers), `exit`.
- **write(data: string|Buffer):** forward keystrokes to the pty.
- **resize(cols, rows):** `pty.resize` → tmux client resize → SIGWINCH → claude redraws.
- **stop({ kill }):** detach (kill the pty client; tmux session + claude keep running) by
  default; `kill: true` → `tmux kill-session -t rc-<id>` then kill the pty.

### Hub integration
- The terminal bridging lives in its own module(s); `session-hub.ts` (already large) only
  routes create / attach / stop / list for terminal sessions and keeps the unified session
  record (mode-tagged). Avoid bloating the hub.
- A terminal record holds the `TerminalProcess` (not a `ClaudeProcess`) plus meta (id, cwd,
  mode, status, createdAt, lastActivityAt). No replay buffer is needed — tmux owns scrollback
  and redraws the current screen on attach.
- Multiple simultaneous viewers: keep ONE pty (tmux client) while ≥1 subscriber; fan its
  output to all; when subscribers drop to 0, detach (kill the pty) but leave tmux running.

### Transport
- `POST /sessions` accepts `mode: "chat" | "terminal"` (default `"chat"`). For terminal mode the
  hub creates a terminal session (no stream-json initialize handshake).
- New **binary** WebSocket route `POST-upgrade /sessions/:id/terminal`:
  - server → client: raw PTY output as **binary** frames.
  - client → server: small JSON text frames — `{ "t": "i", "d": "<utf8 input>" }` (keystrokes)
    and `{ "t": "r", "c": <cols>, "r": <rows> }` (resize). Keystroke volume is tiny, so JSON
    input is fine; output is binary for efficiency.
  - On connect: attach the pty (or join the existing one); tmux redraws the current screen, so
    reconnect "just works" without a server-side replay buffer.
  - Reuses the existing token + origin (CSWSH) + rate-limit gate on the upgrade.
- `GET /version` (or a small `/capabilities`) reports `terminalAvailable: boolean` so the web
  can show/hide the wizard's Terminal toggle.

### Boot rehydration
On server start, `tmux list-sessions` → for each `rc-<id>` matching a `mode='terminal'` db row,
mark the session live/attachable so it reappears in the list after an OTA/launchd restart.

### Feature detection / graceful degrade
If `tmux -V` fails or node-pty can't load, terminal mode is disabled: `terminalAvailable=false`,
the wizard hides the Terminal toggle, and `POST /sessions {mode:"terminal"}` returns an
actionable 400 (e.g. "terminal mode needs tmux on the host"). Chat is unaffected.

## Web & mobile UX

- **Deps:** `@xterm/xterm`, `@xterm/addon-fit` (+ `@xterm/addon-web-links`).
- **`TerminalView.tsx`:** mounts xterm + FitAddon, opens the binary WS, `term.onData(d =>
  ws.send({t:"i",d}))`, `ws.onmessage(bytes => term.write(bytes))`, ResizeObserver → fit →
  send `{t:"r",c,r}`. Theme matches the app.
- **`TerminalKeyBar.tsx` (mobile):** sticky row above the on-screen keyboard with the keys a TUI
  needs but a phone keyboard lacks — `Esc Tab Ctrl ↑ ↓ ← → | ~ / - Ctrl-C Ctrl-D`. `Ctrl` is a
  sticky modifier (next key sent as a control byte). Plus paste (navigator.clipboard) and font
  size +/−. Emits the correct escape sequences (Esc `\x1b`, arrows `\x1b[A/B/C/D`, etc.).
- **Routing:** opening a session renders `TerminalView` when `mode==="terminal"`, else
  `ChatView`. `SessionList` shows a terminal glyph + live/ended state for terminal sessions.
- **Wizard:** a segmented "Chat | Terminal" toggle at the top of `NewSessionWizard`; the cwd /
  model / permission controls are shared between the two modes.

## Persistence & lifecycle

- **Persistence:** tmux owns it. Client disconnect → keep tmux, kill only the pty client when 0
  subscribers. Reconnect → `tmux new -A -s` / attach → tmux redraws. Server/OTA restart → tmux
  sessions survive; boot rehydration re-lists them.
- **claude exits in the TUI:** `remain-on-exit on` leaves a "[exited]" pane; the UI offers a
  Restart (`tmux respawn-pane -t rc-<id> -- claude …`).
- **Closing/deleting a terminal session in the UI:** `tmux kill-session -t rc-<id>` + kill pty.

## Security

- Reuses the existing access-token + origin + rate-limit gate; no new auth surface.
- A raw claude TUI is full RCE on the host, but it does **not widen the trust boundary**: an
  authenticated user can already run arbitrary commands through the existing chat (claude's Bash
  tool / dangerously-skip). Terminal mode makes that more direct, not broader.
- Default **ON** (maintainer's decision); token is the boundary. Documented in the README/SECURITY
  notes alongside the existing RCE caveats. (Graceful-degrade still applies if tmux is absent.)

## Error handling

- tmux / node-pty missing → mode disabled gracefully (chat unaffected), actionable 400/hidden toggle.
- WS drop → tmux persists; client reconnects and re-attaches.
- Resize → debounced; cols/rows sent on attach and on container resize.
- pty spawn failure → surfaced as an actionable error (mirror `ClaudeStartError` style).

## Testing

- **Server — `terminal-process`:** mock `tmux` script (mirroring the `mock-claude-interactive.mjs`
  pattern) driven through node-pty; assert spawn args (`new-session -A -s rc-<id> -- claude …`),
  `remain-on-exit` set, data fan-out, input write, resize forwarding, stop (detach) vs kill
  (`kill-session`), reconnect attach, 0-subscriber detach.
- **Server — boot rehydration:** fake `tmux list-sessions` output → terminal rows marked live.
- **Server — feature detect:** tmux-absent path → `terminalAvailable=false`, `POST /sessions
  {mode:"terminal"}` → 400.
- **Transport:** WS binary output delivery; `{t:"i"}` / `{t:"r"}` handling; auth/origin gate on
  the terminal upgrade; disabled → 400.
- **Web:** `TerminalView` mount / onData→ws / ws→write / fit+resize; `TerminalKeyBar` emits
  correct sequences (incl. sticky Ctrl); wizard mode toggle; `SessionList` terminal rendering.
  (vitest + jsdom; xterm mounted against a DOM/canvas shim or a thin mock.)
- **E2E (skipped by default, like `rewind.live-e2e`):** real tmux + real `claude` TUI smoke —
  spawn, receive a redraw, send input, resize, kill-session.

## Open implementation notes (for the plan, not blockers)

- node-pty is the project's **first native dependency**; confirm prebuilt binaries cover the
  install + OTA build (`pnpm install` / `pnpm -r build`) on macOS/Linux, else document a build
  toolchain requirement. If this proves fragile, the fallback is approach C (tmux control-mode
  `tmux -CC`, pure-JS, no native dep) — same UX, more parsing code.
- Confirm `claude` accepts the model/permission flags we intend to forward in TUI mode; if not,
  launch plain `claude` and let its own UI handle them.
- Decide the exact `terminalAvailable` carrier (extend `/version` vs a new `/capabilities`).
