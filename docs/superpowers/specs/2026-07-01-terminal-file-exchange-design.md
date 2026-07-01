# Terminal file/image exchange — design

Date: 2026-07-01 · Status: approved

## Problem
Chat sessions get the `remote-coder` MCP (`send_image`/`send_file`/`ask_user`) so claude can push media to the
UI, and the composer can upload media to claude. Terminal sessions spawn bare `claude` with no `--mcp-config`,
and xterm can neither render images inline nor upload — so bidirectional file/image exchange is missing in the
terminal. We want it both directions, with a proper UI on desktop and mobile.

## Approach (chosen: "Files panel + single socket")

### 1. MCP for the terminal's claude (server)
When spawning the terminal claude, write the per-session mode-0600 MCP config file (reuse
`buildMcpConfigDocument` + `mcpConfigPathFor`, env `RC_BASE_URL`/`RC_SESSION_ID`/`RC_TOKEN`) and pass
`--mcp-config <path>` in claudeArgs. Delete the file when the session is stopped. Scope: `send_image`/
`send_file`; `ask_user`-in-terminal is a follow-up (its `/ask` overlay isn't wired into TerminalView yet).

### 2. Delivery channel — claude→user, multiplexed on the existing terminal WS
Server→client today = **binary** frames (pty bytes). Add server→client **text** frames = JSON control, e.g.
`{"t":"attach","kind":"image"|"file","name":..,"path":..,"mime":..}`. The web socket splits by frame type:
`ArrayBuffer` → `xterm.write`; `string` → `onControl(JSON)`. `/sessions/:id/attach` (where the MCP POSTs)
routes to the **TerminalManager** for terminal ids and fans a control frame to attached WS clients. No 2nd
socket. `send_file`/`send_image` differ only by `kind` (image → thumbnail, file → row).

### 3. Files panel (web)
`📎 Files (N)` button in the terminal header (optional prop on ChatHeader, like the close X). Opens a panel —
**bottom sheet on mobile, side drawer on desktop** — listing exchanged items (received-from-claude +
uploaded-by-user): image thumbnails / file rows, each with **view full-size + download** (URL built from the
path via the existing token'd `downloadUrl` helper). State (the list) lives in TerminalView.

### 4. Upload — user→claude
The panel has **Upload** (+ drag-drop & paste on desktop). POST to the existing upload endpoint; save under
the session cwd (a real path claude can read). On success, **insert the absolute path into the terminal**
(`sendInput(path + " ")`) so the user can ask claude to read it, and add it to the panel list.

## Components / boundaries
- `terminal-process.ts`/`terminal-manager.ts`: accept an `mcpConfigPath`; write/cleanup the config file;
  a `control` fan-out (like the existing `data`/`exit` fan-out) delivering JSON control frames to subs.
- `transport.ts`: on terminal create, write the MCP config + add `--mcp-config`; `/attach` routes terminal
  ids to the manager's control fan-out; terminal WS forwards control frames as text; a terminal upload route
  (reuse `/fs/upload`).
- web `terminal-socket.ts`: `onControl` alongside `onData`, split by frame type.
- web `TerminalView.tsx` + a new `TerminalFiles` panel component: the list, thumbnails, upload, path-inject.
- web `ChatHeader.tsx`: optional `onOpenFiles` + count badge.

## Testing
Unit: control-frame split (socket), attach→control routing (transport/manager), upload path-inject. Live
(headless, desktop + mobile DPR): terminal claude `send_image` → thumbnail in the panel; upload → path lands
in the terminal. Full suite + tsc + build green; ship via push→OTA.

## Deferred
`ask_user` in the terminal; inline (sixel/kitty) image rendering in xterm; drag-drop on mobile.
