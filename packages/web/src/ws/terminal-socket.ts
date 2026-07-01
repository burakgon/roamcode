export interface TerminalSocket {
  sendInput(d: string): void;
  sendResize(cols: number, rows: number): void;
  close(): void;
}

/** Connection lifecycle surfaced to the view. `reconnecting` = a transient drop, auto-retrying; `ended` =
 *  a terminal state (claude exited or the session is gone) — no retry, the view offers Restart/Close. */
export type TerminalStatus = "open" | "reconnecting" | "ended";

// Server close codes that are FATAL (do not reconnect): 4410 = session ended (claude exited), 4404 =
// session not found. Anything else (network drop, server restart, 1006) is transient → reconnect.
const FATAL_CLOSE_CODES = new Set([4404, 4410]);

/**
 * A terminal WebSocket that AUTO-RECONNECTS. The tmux session survives a dropped connection (server-side
 * persistence), so a network blip / server OTA restart / phone sleep must transparently re-attach instead
 * of leaving a dead terminal. Reconnects with exponential backoff + jitter (capped), and STOPS on a fatal
 * close code (ended / not-found) so it never hammer-retries an unrecoverable session.
 */
export function createTerminalSocket(opts: {
  url: string;
  onData: (bytes: Uint8Array) => void;
  onStatus?: (s: TerminalStatus) => void;
  /** Out-of-band control messages (JSON text frames) — file/image attachments claude sent. The server
   *  sends pty output as BINARY frames and control as TEXT frames, so we split by frame type. */
  onControl?: (json: string) => void;
}): TerminalSocket {
  let ws: WebSocket | undefined;
  let closedByCaller = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closedByCaller) return;
    const sock = new WebSocket(opts.url);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      opts.onStatus?.("open");
    };
    sock.onmessage = (e: MessageEvent) => {
      // BINARY = raw pty output; TEXT (string) = a control frame (attachment JSON).
      if (e.data instanceof ArrayBuffer) opts.onData(new Uint8Array(e.data));
      else if (typeof e.data === "object" && e.data !== null && "byteLength" in e.data) opts.onData(new Uint8Array(e.data));
      else if (typeof e.data === "string") opts.onControl?.(e.data);
    };
    sock.onerror = () => {
      /* the close event follows and drives reconnect/ended */
    };
    sock.onclose = (e: CloseEvent) => {
      if (closedByCaller || ws !== sock) return; // superseded or intentionally closed
      if (FATAL_CLOSE_CODES.has(e.code)) {
        opts.onStatus?.("ended");
        return;
      }
      // Transient drop → back off and retry (0.5s, 1s, 2s, … capped at 15s, + jitter).
      opts.onStatus?.("reconnecting");
      const delay = Math.min(15000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };
  };
  connect();

  const openSend = (o: unknown) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };
  return {
    sendInput: (d) => openSend({ t: "i", d }),
    sendResize: (cols, rows) => openSend({ t: "r", c: cols, r: rows }),
    close: () => {
      closedByCaller = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
    },
  };
}
