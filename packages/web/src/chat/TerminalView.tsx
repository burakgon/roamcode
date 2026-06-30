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
    const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: "#0b0e14" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const sock = createTerminalSocket({
      url: terminalWsUrl(sessionId),
      onData: (bytes) => term.write(bytes),
    });
    sockRef.current = sock;
    const offData = term.onData((d) => sock.sendInput(d));
    const sendSize = () => {
      fit.fit();
      sock.sendResize(term.cols, term.rows);
    };
    // Re-fit + report the new size whenever the host resizes (rotation, keyboard, split). Feature-
    // detected — jsdom (tests) and any SSR pass lack ResizeObserver; we still send the initial size.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => sendSize()) : undefined;
    ro?.observe(host);
    sendSize();

    return () => {
      ro?.disconnect();
      offData?.dispose();
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
  flex: 1; min-height: 0;
  padding: var(--sp-2);
  overflow: hidden;
}
`;
