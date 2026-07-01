import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
type CreateSocket = typeof createTerminalSocket;
import { terminalWsUrl, terminalDownloadUrl, terminalUpload } from "../api/client";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { TerminalFiles, type TermFile } from "./TerminalFiles";
import { ChatHeader } from "./ChatHeader";
import { keySequence, ctrlSeq } from "./terminal-keys";
import type { SessionMeta } from "../types/server";

/** A full dark theme so xterm never falls back to default ANSI colors / a black viewport seam. */
const THEME = {
  background: "#0b0e14",
  foreground: "#cdd6e4",
  cursor: "#cdd6e4",
  cursorAccent: "#0b0e14",
  selectionBackground: "#2a3340",
  black: "#11151c",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#cdd6e4",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
} as const;

/** Renders a terminal session's claude TUI: xterm.js bridged to the binary terminal WebSocket.
 *  `createSocket` is injectable purely so the screenshot harness / tests can feed controlled bytes;
 *  production always uses the default real socket. */
export function TerminalView({
  session,
  onShowSessions,
  needsYou,
  onClose,
  createSocket = createTerminalSocket,
}: {
  session: SessionMeta;
  onShowSessions?: () => void;
  needsYou?: number;
  /** Close/stop the session (header X + the "session ended" overlay's Close button). */
  onClose?: () => void;
  createSocket?: CreateSocket;
}) {
  const sessionId = session.id;
  const cwd = session.cwd;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const sockRef = useRef<TerminalSocket | undefined>(undefined);
  // Sticky Ctrl: a ref drives the keydown handler (set once), state drives the button highlight.
  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmedState] = useState(false);
  const setCtrlArmed = (v: boolean) => {
    ctrlArmedRef.current = v;
    setCtrlArmedState(v);
  };
  // Connection lifecycle → drives the reconnect/ended overlay. `restartKey` bump remounts the effect (fresh
  // terminal + socket → reattach, which respawns a fresh claude for an ended session).
  const [connState, setConnState] = useState<"connecting" | "open" | "reconnecting" | "ended">("connecting");
  const [restartKey, setRestartKey] = useState(0);
  // Files exchanged with claude: received (send_image/send_file → control frames) + uploaded by the user.
  const [files, setFiles] = useState<TermFile[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const restart = () => {
    setConnState("connecting");
    setRestartKey((k) => k + 1);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: { ...THEME },
      allowProposedApi: true,
      // A finite scrollback so claude's NORMAL-buffer output (long errors, git diffs, results taller than the
      // viewport) stays scrollable. Its full-screen TUI uses the alt-screen (tmux owns that), unaffected.
      scrollback: 1000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Stop mobile soft keyboards from mangling terminal input: no auto-capitalize/correct/complete/spellcheck
    // on xterm's hidden input textarea (otherwise "ls" → "Ls", flags/paths get autocorrected).
    const helper = host.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    if (helper) {
      helper.setAttribute("autocapitalize", "off");
      helper.setAttribute("autocorrect", "off");
      helper.setAttribute("autocomplete", "off");
      helper.setAttribute("spellcheck", "false");
    }

    let disposed = false;
    let connected = false;

    // Renderer: xterm's DEFAULT (DOM). The WebGL addon rounds cells to integer device pixels → HiDPI fit
    // drift (the "kayık"/shift); the beta Canvas addon mis-sizes its backing store at HiDPI (everything
    // renders 2-3× and clips). The DOM renderer uses CSS-sized cells and renders correctly on every device.
    // (The logo's block glyphs come through intact now that the server runs tmux with `-u` + a UTF-8 locale.)

    // Sticky Ctrl applied to the REAL/soft keyboard: when armed, the next single printable keypress becomes
    // its control byte (Ctrl-R, Ctrl-L, …) and xterm's own handling of it is suppressed. This is what makes
    // the bar's "Ctrl" actually work for typed keys, not just the bar's buttons.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.isComposing || e.keyCode === 229) return true; // IME composition — never intercept
      if (!ctrlArmedRef.current) return true;
      // Ctrl is armed:
      if (e.key === "Escape") {
        setCtrlArmed(false); // cancel the arm and swallow the Esc
        return false;
      }
      if (e.altKey || e.metaKey) return true; // don't hijack Alt/Meta combos
      if (e.key.length === 1) {
        sockRef.current?.sendInput(ctrlSeq(e.key));
        setCtrlArmed(false);
        return false;
      }
      // Armed but a non-printable key (Enter/Backspace/Arrow/Tab/…): DISARM and let it pass normally, so a
      // stray arm never silently turns a later letter into a destructive control byte (e.g. Ctrl-L clear).
      setCtrlArmed(false);
      return true;
    });

    const refit = () => {
      if (disposed || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      sockRef.current?.sendResize(term.cols, term.rows);
    };
    // FIT FIRST, THEN connect with the fitted size in the URL, so the pty/tmux is BORN at the real viewport
    // (no spawn-at-80×24-then-reflow jump). Only connect once the host has a real size.
    const fitThenConnect = () => {
      if (connected || disposed || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      connected = true;
      const sock = createSocket({
        url: terminalWsUrl(sessionId, term.cols, term.rows),
        onData: (bytes) => {
          if (!disposed) term.write(bytes);
        },
        onStatus: (s) => {
          if (disposed) return;
          if (s === "open") {
            setConnState("open");
            // Clear any stale frame from a prior connection; tmux sends a full redraw on (re)attach, so the
            // screen repaints cleanly instead of overlaying the old one.
            term.reset();
            refit();
          } else if (s === "reconnecting") {
            setConnState("reconnecting");
          } else if (s === "ended") {
            setConnState("ended");
          }
        },
        onControl: (json) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(json) as { t?: string; id?: string; name?: string; path?: string; isImage?: boolean; caption?: string };
            if (msg.t === "attach" && typeof msg.path === "string") {
              const item: TermFile = {
                id: msg.id ?? msg.path,
                name: msg.name ?? "file",
                path: msg.path,
                isImage: !!msg.isImage,
                source: "received",
                caption: msg.caption,
              };
              setFiles((prev) => (prev.some((f) => f.id === item.id) ? prev : [item, ...prev]));
            }
          } catch {
            /* ignore a malformed control frame */
          }
        },
      });
      sockRef.current = sock;
    };
    const tick = () => (connected ? refit() : fitThenConnect());

    const offData = term.onData((d) => sockRef.current?.sendInput(d));

    // two rAFs (layout settled) → fit+connect; fonts.ready re-fits once the webfont swaps in; RO handles
    // rotation / on-screen keyboard / split-view resizes (and connects if the host wasn't sized yet).
    const raf = requestAnimationFrame(() => requestAnimationFrame(tick));
    document.fonts?.ready?.then(tick).catch(() => undefined);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => tick()) : undefined;
    ro?.observe(host);
    // Fallback: a host that mounts hidden (display:none tab / collapsed) has clientHeight 0 and the rAF
    // bails; ResizeObserver doesn't fire for display:none→visible in some browsers. Poll until connected.
    const poll = setInterval(() => {
      if (disposed || connected) {
        clearInterval(poll);
        return;
      }
      tick();
    }, 500);
    // Re-fit + refocus (and connect if we hadn't yet) when the tab/app returns to the foreground.
    const onVisible = () => {
      if (!document.hidden && !disposed) {
        tick();
        term.focus();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    term.focus();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      ro?.disconnect();
      offData.dispose();
      sockRef.current?.close();
      term.dispose();
      sockRef.current = undefined;
      termRef.current = undefined;
    };
  }, [sessionId, createSocket, restartKey]);

  // Bar keys: emit the cursor-mode-correct bytes for the CURRENT terminal mode (arrows/Home/End), then keep
  // focus on the terminal so the on-screen keyboard stays up.
  const onBarKey = (label: string) => {
    const term = termRef.current;
    const appMode = !!term?.modes?.applicationCursorKeysMode;
    sockRef.current?.sendInput(keySequence(label, appMode));
    term?.focus();
  };
  const onCtrlChord = (letter: string) => {
    sockRef.current?.sendInput(ctrlSeq(letter));
    setCtrlArmed(false);
    termRef.current?.focus();
  };
  // Mobile paste: xterm's own paste needs a physical Ctrl/Cmd-V a phone lacks, so the bar offers a Paste
  // button that reads the clipboard and sends it as input. Best-effort (needs a secure context + permission).
  const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;
  const onPaste = () => {
    navigator.clipboard
      ?.readText?.()
      .then((text) => {
        if (text) sockRef.current?.sendInput(text);
        termRef.current?.focus();
      })
      .catch(() => undefined);
  };
  // Upload → save under the session cwd, list it, and hand claude the absolute PATH (it reads by path).
  const onUploadFiles = (list: FileList) => {
    for (const file of Array.from(list)) {
      terminalUpload(cwd, file)
        .then(({ path }) => {
          setFiles((prev) => [
            { id: path, name: file.name, path, isImage: file.type.startsWith("image/"), source: "sent" },
            ...prev,
          ]);
          sockRef.current?.sendInput(path + " ");
          termRef.current?.focus();
        })
        .catch(() => setUploadError(`Couldn't upload ${file.name}`));
    }
  };

  return (
    <div className="rc-terminal">
      <ChatHeader
        session={session}
        onShowSessions={onShowSessions}
        needsYou={needsYou}
        onClose={onClose}
        onOpenFiles={() => setFilesOpen(true)}
        filesCount={files.length}
      />
      <div className="rc-terminal__stage">
        <div className="rc-terminal__host" ref={hostRef} role="group" aria-label="Terminal" />
        {connState === "reconnecting" && (
          <div className="rc-term-toast" role="status">
            <span className="rc-term-toast__dot" aria-hidden="true" /> Reconnecting…
          </div>
        )}
        {connState === "ended" && (
          <div className="rc-term-ended" role="alertdialog" aria-label="Session ended">
            <div className="rc-term-ended__card">
              <div className="rc-term-ended__title">claude exited</div>
              <div className="rc-term-ended__sub">The terminal session ended.</div>
              <div className="rc-term-ended__actions">
                <button type="button" className="rc-term-ended__primary" onClick={restart}>
                  Restart
                </button>
                {onClose && (
                  <button type="button" className="rc-term-ended__ghost" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <TerminalKeyBar
        ctrlArmed={ctrlArmed}
        onToggleCtrl={() => setCtrlArmed(!ctrlArmedRef.current)}
        onKey={onBarKey}
        onCtrlChord={onCtrlChord}
        onPaste={canPaste ? onPaste : undefined}
      />
      <TerminalFiles
        files={files}
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        onUpload={onUploadFiles}
        downloadUrl={terminalDownloadUrl}
      />
      {uploadError && (
        <button type="button" className="rc-term-uploaderr" onClick={() => setUploadError(undefined)}>
          {uploadError} — tap to dismiss
        </button>
      )}
      <style>{terminalCss}</style>
    </div>
  );
}

const terminalCss = `
.rc-terminal {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: #0b0e14;
}
/* The stage is the flex-fill region + the positioning context for the reconnect/ended overlays. */
.rc-terminal__stage { position: relative; flex: 1 1 auto; min-height: 0; }
.rc-terminal__host {
  position: absolute; inset: 0;
  overflow: hidden;
}
/* Reconnecting toast — a small pill, top-center, non-blocking. */
.rc-term-toast {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 5;
  display: flex; align-items: center; gap: 7px;
  padding: 5px 11px; border-radius: 999px;
  background: #1b2230; border: 1px solid #2a3340; color: #cdd6e4;
  font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.rc-term-toast__dot { width: 7px; height: 7px; border-radius: 999px; background: #e5c07b; animation: rc-term-pulse 1s ease-in-out infinite; }
@keyframes rc-term-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
/* Session-ended overlay — a centered card scrimming the dead terminal, with Restart / Close. */
.rc-term-ended {
  position: absolute; inset: 0; z-index: 6;
  display: grid; place-items: center;
  background: rgba(11,14,20,0.72); backdrop-filter: blur(2px);
}
.rc-term-ended__card {
  min-width: 220px; max-width: 90%; padding: 20px;
  background: #11151c; border: 1px solid #2a3340; border-radius: 12px;
  text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
.rc-term-ended__title { font: 600 15px/1.3 "JetBrains Mono", ui-monospace, monospace; color: #cdd6e4; }
.rc-term-ended__sub { margin-top: 4px; font-size: 12px; color: #5c6370; }
.rc-term-ended__actions { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }
.rc-term-ended__primary, .rc-term-ended__ghost {
  min-height: 38px; padding: 0 16px; border-radius: 9px; cursor: pointer;
  font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  touch-action: manipulation;
}
.rc-term-ended__primary { background: #e06c75; color: #11151c; border: 1px solid #e06c75; }
.rc-term-ended__ghost { background: transparent; color: #cdd6e4; border: 1px solid #2a3340; }
/* Upload error toast — tap to dismiss. */
.rc-term-uploaderr {
  position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%); z-index: 8;
  max-width: 88%; padding: 8px 14px; border-radius: 10px; cursor: pointer;
  background: #3a2226; border: 1px solid #e06c75; color: #f0c4c8;
  font: 500 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
/* The padding lives on .xterm (NOT the host): FitAddon reads padding from the terminal element, so padding
   on the host was never subtracted from the grid math → the right column / bottom row got clipped ("shifted"). */
.rc-terminal__host .xterm { height: 100%; box-sizing: border-box; padding: 6px; }
/* Neutralize global text styling the terminal must not inherit: body sets letter-spacing: 0.1px, which a
   character grid must never have (it drifts the columns) — matters for the DOM fallback renderer. */
.rc-terminal__host .xterm, .rc-terminal__host .xterm * { letter-spacing: normal; }
/* xterm.css hardcodes the viewport background to #000; match the theme so there's no black seam on resize. */
.rc-terminal__host .xterm-viewport { background-color: #0b0e14 !important; }

/* Termux-style extra-keys row: a horizontally scrollable, touch-friendly key strip pinned below the
   terminal, with a safe-area inset so it clears the iOS home indicator / sits above the on-screen keyboard. */
.rc-termkeys {
  flex: 0 0 auto;
  display: flex; gap: 6px; align-items: center;
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px));
  background: #11151c; border-top: 1px solid #1e2530;
  overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.rc-termkeys::-webkit-scrollbar { display: none; }
.rc-termkeys button {
  flex: 0 0 auto; min-width: 38px; height: 36px; padding: 0 11px; margin: 0;
  border: 1px solid #2a3340; border-radius: 8px;
  background: #1b2230; color: #cdd6e4;
  font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap; cursor: pointer; user-select: none;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
}
.rc-termkeys button:active { background: #2a3340; }
.rc-termkeys .rc-termkeys__ctrl.is-on { background: #3b82f6; color: #fff; border-color: #3b82f6; }
/* The on-screen key bar exists for devices WITHOUT a physical keyboard. Hide it only where the PRIMARY
   pointer is a mouse/trackpad (a real desktop) — keyed off INPUT TYPE, not width, so a FOLDABLE phone
   (wide when unfolded but still touch, even with an S-Pen as a secondary pointer) keeps the keys. */
@media (hover: hover) and (pointer: fine) { .rc-termkeys { display: none; } }
`;
