# Ghostty experimental renderer baseline

Date: 2026-07-25

Status: experimental option; xterm.js remains the default

## Scope and decision

RoamCode now offers Ghostty as a device-local renderer choice under
Settings → Appearance. Selecting it persists only in that browser and requires
a reload. It does not replace or alter the existing xterm.js path.

This phase intentionally stops at a thin integration of Ghostty's official VT,
render, key, paste, mouse, resize and scroll APIs. It does not emulate xterm.js
or port RoamCode's xterm-specific product features. The purpose is to observe
the upstream behavior first and make later feature work evidence-driven.

## Exact upstream and reproducibility

- Repository: `https://github.com/ghostty-org/ghostty.git`
- Source: official `main` commit
  `4c725242b7dbe8c77c6e227ef1f9540c5ef17921` (2026-07-24)
- Required compiler: Zig `0.16.0`
- Build: `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding
  -Doptimize=ReleaseSmall`
- Committed artifact: 702,329 bytes
- SHA-256:
  `ba4dfb2cdb5dfb1c9924552983e04af18d36a9b98de41a6aef74bed6d0202db2`

`pnpm ghostty:verify` checks the committed metadata and hash, checks out the
exact upstream commit in a temporary directory, rebuilds it without source
changes, and requires a byte-identical result. CI runs the same check.

`pnpm ghostty:update` resolves the current official `main`, builds it with the
Zig version declared by that checkout, and updates the pin, artifact and
metadata. An upstream ABI change still requires an explicit bridge review.

No code from the separate `ghostty-web` npm project is bundled. The browser
bridge is local code against Ghostty's public `libghostty-vt` API. The
distributed web bundle includes Ghostty's third-party notice.

## What works in the baseline

| Capability | Status | Ownership | Evidence |
| --- | --- | --- | --- |
| VT parsing, ANSI/SGR state, cursor and screen state | Works | Ghostty native | WASM tests and Chromium canvas smoke |
| Unicode graphemes and wide-cell layout | Works | Ghostty native | CJK wide/head-tail test |
| Physical keyboard and control/navigation keys | Works | Ghostty native encoder + browser event bridge | Ctrl-C and Arrow Up encoder tests |
| IME/composition and `beforeinput` text | Implemented, needs wider device validation | Browser glue | Browser event bridge; not yet Safari/iOS verified |
| Plain and bracketed paste | Works | Ghostty native paste encoder + ClipboardEvent bridge | Both modes tested |
| Application mouse reporting | Works at protocol level | Ghostty native encoder + pointer bridge | SGR mouse-mode test |
| Wheel scrollback when the application does not own the mouse | Works | Ghostty native viewport + browser wheel bridge | API bridge exercised |
| Resize and device-pixel-ratio canvas | Works | Browser glue | Chromium fitted 900×683 canvas |
| RoamCode socket, reconnect and one-writer input lease | Works | Shared product transport/safety | Existing socket contract reused |
| Renderer load isolation | Works | Build/PWA | Separate 702 KB WASM; absent from cold entry and precache |
| Offline reuse after first Ghostty load | Works by design | Service worker | Versioned runtime cache, cache-first after opt-in |
| Explicit recovery | Works | Product shell | Retry Ghostty or switch to xterm.js; no silent fallback |

Local Chromium smoke rendered the deterministic terminal scene with the pinned
commit banner, a fitted canvas, one WASM resource, and no runtime error.
macOS Safari, iOS standalone PWA, Android Chrome and Firefox are not yet claimed
as verified.

## Gaps before feature parity

These are deliberately visible gaps, not hidden compatibility shims.

| Priority | Gap | Category | What it would require |
| --- | --- | --- | --- |
| P0 | Text selection, touch handles, copy and context-menu behavior | Browser glue over Ghostty native selection APIs | Map pointer gestures to Ghostty selection, expose selected text, integrate clipboard permissions |
| P0 | Mobile terminal key bar, locked Ctrl/Alt, keyboard dismiss and compose/dictation box | RoamCode product feature | Renderer-neutral input controls that feed Ghostty's official encoder/paste API |
| P0 | File receive/upload panel, drag/drop, paste-file handling and image editor | RoamCode product feature | Reattach the existing control-frame/file UI outside renderer-specific code |
| P1 | Search, next/previous match and jump-to-latest affordance | RoamCode product feature | Renderer-neutral buffer query/viewport controls; avoid reimplementing terminal parsing |
| P1 | OSC 8/plain URL activation and safe mouse/link arbitration | Browser glue + product policy | Read upstream hyperlink metadata, apply RoamCode's external-link policy, arbitrate application mouse mode |
| P1 | Font zoom persistence and re-fit controls | RoamCode product feature | Change canvas metrics, resize Ghostty and PTY together |
| P1 | Sustained-output performance profiling and incremental redraw | Browser renderer glue | Measure large/rapid terminal streams on target devices, then use Ghostty render-state changes to avoid full-grid canvas work where possible |
| P1 | Exact conversation resume and startup-failure guidance on the ended screen | RoamCode product feature | Reuse the renderer-neutral session identity/respawn policy |
| P1 | Multi-user presence count | RoamCode product feature | Reuse the shared presence API; input-lease enforcement and confirmed takeover are already retained |
| P2 | Help sheet, gesture education and two-finger scroll hint | RoamCode product feature | Renderer-specific help content based on validated device behavior |
| P2 | Screen-reader-quality terminal semantics | Browser glue / accessibility | A DOM/ARIA mirror or another accessible presentation of Ghostty render state |
| P2 | Blink timing, richer decoration/color details and app-theme integration | Browser renderer glue | Canvas animation and full style/palette policy |
| P2 | Kitty graphics/image placements | Browser glue over Ghostty native graphics APIs | Browser-safe decoding callbacks, placement iteration and canvas texture rendering |
| P2 | Ghostty desktop-quality font shaping, fallback and ligatures | Upstream browser frontend gap | The official repository currently supplies the VT/WASM core, not its native renderer/font stack as a ready browser terminal |

## Recommended next checkpoint

Do not pursue full xterm parity in one pass. Validate this baseline on the
actual desktop/mobile devices first. If Ghostty's raw rendering and input
behavior are acceptable, the smallest useful next slice is:

1. selection/copy;
2. the mobile key/compose controls;
3. the renderer-neutral file panel;
4. link activation.

Those four close the largest day-to-day usability gaps while keeping terminal
semantics owned by Ghostty. Search, graphics, accessibility mirroring and
desktop-grade font shaping should remain separate decisions with their own
evidence.
