import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSocket, type TerminalSocket } from "../ws/terminal-socket";
import { terminalWsUrl } from "../api/client";
import { TerminalKeyBar } from "./TerminalKeyBar";

/** Renders a terminal session's claude TUI: xterm.js bridged to the binary terminal WebSocket. */
export function TerminalView({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<TerminalSocket | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: { background: "#0b0e14" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let disposed = false;
    // fit() needs the host laid out AND the font's cell metrics measured; called too early it computes the
    // wrong grid and the terminal doesn't fill (the "doesn't cover the screen until you resize" bug). So we
    // never fit synchronously on open — only after layout settles, after the web font loads, and on resize.
    const refit = () => {
      if (disposed || host.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      sockRef.current?.sendResize(term.cols, term.rows);
    };

    const sock = createTerminalSocket({
      url: terminalWsUrl(sessionId),
      onData: (bytes) => term.write(bytes),
      // The PTY/tmux is born at a default size; once the socket is open, push the fitted size so the claude
      // TUI reflows to the real viewport immediately (not just after the first manual resize).
      onStatus: (s) => {
        if (s === "open") refit();
      },
    });
    sockRef.current = sock;
    const offData = term.onData((d) => sock.sendInput(d));

    // Initial fit AFTER two frames (layout has settled) + again once the web font finishes loading (cell
    // metrics change when the real monospace face swaps in).
    const raf = requestAnimationFrame(() => requestAnimationFrame(refit));
    document.fonts?.ready?.then(refit).catch(() => undefined);

    // Re-fit on any host resize (rotation, on-screen keyboard, split view). Feature-detected — jsdom (tests)
    // and SSR lack ResizeObserver; the rAF/fonts paths still perform the initial fit there.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => refit()) : undefined;
    ro?.observe(host);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      offData.dispose();
      sock.close();
      term.dispose();
      sockRef.current = undefined;
    };
  }, [sessionId]);

  return (
    <div className="rc-terminal">
      <div className="rc-terminal__host" ref={hostRef} />
      <TerminalKeyBar onSend={(seq) => sockRef.current?.sendInput(seq)} />
      <style>{terminalCss}</style>
    </div>
  );
}

const terminalCss = `
.rc-terminal {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: #0b0e14;
}
.rc-terminal__host {
  flex: 1 1 auto; min-height: 0;
  padding: var(--sp-2, 6px);
  overflow: hidden;
}
/* Make xterm actually fill the host so the grid covers the pane from the first paint. */
.rc-terminal__host .xterm { height: 100%; }

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
`;
