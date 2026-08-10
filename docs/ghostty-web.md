# Ghostty Web terminal

RoamCode uses the official Ghostty VT core as its only browser terminal
implementation. The React product shell and the public-site playground both
use the local `@roamcode.ai/ghostty-web` bridge.

## Upstream pin and reproducibility

- Repository: `https://github.com/ghostty-org/ghostty.git`
- Source: official `main` commit
  `66fed652a148cda9d8ea90b1b34ae9768871dbd9`
- Required compiler: Zig `0.16.0`
- Build: `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding
  -Doptimize=ReleaseSmall`
- Committed artifact: 702,329 bytes
- SHA-256:
  `ba4dfb2cdb5dfb1c9924552983e04af18d36a9b98de41a6aef74bed6d0202db2`

`packages/ghostty-web/ghostty-upstream.json` is the source of truth for the
pin. `pnpm ghostty:verify` checks the metadata and hash, checks out that exact
upstream commit in a temporary directory, rebuilds it without source changes,
and requires byte-identical output. CI runs the same verification.

`pnpm ghostty:update` resolves official `main`, builds it with the Zig version
declared by that checkout, and updates the pin, artifact, and metadata. An
upstream ABI change still requires explicit bridge review.

No code from the separate `ghostty-web` npm project is bundled. The bridge
calls Ghostty's public `libghostty-vt` API, and the distributed web bundle
includes Ghostty's third-party notice.

## Ownership boundary

Ghostty owns VT parsing, terminal modes, keyboard and mouse encoding, paste
framing, scrollback, selection ranges, colors, graphemes, wide cells, OSC 8
links, cursor state, and screen buffers. The browser layer is responsible only
for DOM events, canvas drawing, clipboard integration, accessibility text,
device-pixel sizing, and product UI around the terminal.

RoamCode retains its existing product features around that core: socket
reconnect and resume, direct authenticated input, presence, search, font zoom,
mobile key controls and sticky modifiers, touch selection handles, safe link
opening, files and uploads, image editing, compose and dictation, ended-session
recovery, and split-screen lifecycle.

Right-click follows Ghostty's native arbitration. Application mouse reporting
gets first refusal. Otherwise Ghostty selects the word under the pointer and
the browser or operating system opens its native context menu. RoamCode does
not add a desktop context-menu popup.
