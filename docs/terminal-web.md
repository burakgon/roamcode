# Browser terminal

RoamCode renders its browser terminal with xterm.js 6 and the default DOM renderer. The PWA and the website
playground load xterm lazily; no WebGL, Canvas addon, or terminal WebAssembly runtime is shipped.

## Runtime contract

- `TerminalView` fits xterm before opening the terminal WebSocket so tmux starts at the visible grid size.
- The browser retains 20,000 normal-buffer rows, matching the maximum reconnect seed. The server-owned tmux pane
  remains the durable 100,000-line history source.
- Incoming binary frames are submitted in 64 KiB chunks. This lets xterm yield between parser writes even when a
  reconnect seed arrives as one 12 MiB WebSocket frame.
- Reconnect replay suppresses historical clipboard protocol side effects until xterm's final write callback.
- Normal-buffer history belongs to xterm's native viewport. Alternate-screen and mouse-aware applications continue
  to own wheel and pointer input.

## Input and clipboard

RoamCode uses xterm's current terminal modes for keyboard, bracketed-paste, and mouse encoding. A small key helper
keeps the mobile toolbar's Ctrl lock and DECCKM cursor sequences consistent with hardware input.

Application clipboard writes support OSC 52 and iTerm2 OSC 1337 `Copy=:`. The handlers are write-only: clipboard
read queries are swallowed, malformed base64 or UTF-8 is ignored, and decoded text is capped at 512 KiB. The default
xterm clipboard addon is intentionally not loaded because RoamCode never exposes the user's clipboard to a remote
application.

## Appearance

The 602-theme catalog and saved appearance keys remain compatible with existing installations. Each 16-color palette
is mapped to xterm's named ANSI colors; cursor, selection, OLED, and bundled-font changes apply to an open terminal.
The catalog's source licenses ship as `terminal-theme-NOTICES.md`.
