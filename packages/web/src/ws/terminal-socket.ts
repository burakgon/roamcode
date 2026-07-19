export interface TerminalSocket {
  sendInput(d: string): void;
  sendResize(cols: number, rows: number): void;
  /** Request or relinquish the single mutable input stream. Older injected socket implementations may omit
   *  this while the server-side enforcement still keeps observer connections read-only. */
  requestInputLease?(action: "acquire" | "takeover" | "renew" | "release", confirm?: boolean): void;
  /** Force an immediate reconnect and reset the backoff — for a manual "Reconnect now" tap or a back-online
   *  event, so the user isn't stuck waiting out the (up to 15s) backoff after the phone wakes. */
  reconnect(): void;
  close(): void;
}

/** Connection lifecycle surfaced to the view. `reconnecting` = a transient drop, auto-retrying; `ended` =
 *  a terminal state (claude exited or the session is gone) — no retry, the view offers Restart/Close. */
export type TerminalStatus = "open" | "reconnecting" | "ended";

export interface TerminalSocketOptions {
  /** Structured context kept for custom direct transports; the browser WebSocket implementation ignores it. */
  sessionId?: string;
  cols?: number;
  rows?: number;
  respawn?: "continue" | "fresh";
  /** The WS URL, or a THUNK re-evaluated on every (re)connect so a rotated token / resized viewport is picked
   *  up — a fixed string would reconnect forever with the stale token captured at first connect. May be
   *  ASYNC: the ticket flow (terminalWsTicketUrl) fetches a single-use WS ticket per attempt so the
   *  long-lived token stays out of WS URLs / access logs. */
  url: string | (() => string | Promise<string>);
  onData: (bytes: Uint8Array) => void;
  onStatus?: (s: TerminalStatus) => void;
  /** Out-of-band control messages (JSON text frames) — file/image attachments claude sent. The server
   *  sends pty output as BINARY frames and control as TEXT frames, so we split by frame type. */
  onControl?: (json: string) => void;
}

// Server close codes that are FATAL (do not reconnect): 4410 = session ended (claude exited), 4404 =
// session not found. Anything else (network drop, server restart, 1006) is transient → reconnect.
const FATAL_CLOSE_CODES = new Set([4404, 4410]);

/**
 * A terminal WebSocket that AUTO-RECONNECTS. The tmux session survives a dropped connection (server-side
 * persistence), so a network blip / server OTA restart / phone sleep must transparently re-attach instead
 * of leaving a dead terminal. Reconnects with exponential backoff + jitter (capped), and STOPS on a fatal
 * close code (ended / not-found) so it never hammer-retries an unrecoverable session.
 */
export function createTerminalSocket(opts: TerminalSocketOptions): TerminalSocket {
  let ws: WebSocket | undefined;
  let closedByCaller = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRetry = () => {
    // Transient drop / failed URL build → back off and retry (0.5s, 1s, 2s, … capped at 15s, + jitter).
    opts.onStatus?.("reconnecting");
    const delay = Math.min(15000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (closedByCaller) return;
    const resolved = typeof opts.url === "function" ? opts.url() : opts.url; // fresh token/ticket per attempt
    if (typeof resolved === "string") {
      // Plain/sync URL → open SYNCHRONOUSLY (string thunks and their callers/tests rely on the socket
      // existing right after createTerminalSocket returns; only the ticket flow needs the async path).
      open(resolved);
      return;
    }
    resolved
      .then((url) => {
        if (!closedByCaller) open(url);
      })
      .catch(() => {
        // The URL thunk itself failed (ticket fetch during a server restart) — same path as a dropped socket.
        if (!closedByCaller) scheduleRetry();
      });
  };

  const open = (url: string) => {
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      opts.onStatus?.("open");
    };
    sock.onmessage = (e: MessageEvent) => {
      if (closedByCaller || ws !== sock) return;
      // BINARY = raw pty output; TEXT (string) = a control frame (attachment JSON).
      if (e.data instanceof ArrayBuffer) opts.onData(new Uint8Array(e.data));
      else if (typeof e.data === "object" && e.data !== null && "byteLength" in e.data)
        opts.onData(new Uint8Array(e.data));
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
      scheduleRetry();
    };
  };
  connect();

  const openSend = (o: unknown) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };
  return {
    sendInput: (d) => openSend({ t: "i", d }),
    sendResize: (cols, rows) => openSend({ t: "r", c: cols, r: rows }),
    requestInputLease: (action, confirm) =>
      openSend({ t: "lease", action, ...(confirm === undefined ? {} : { confirm }) }),
    reconnect: () => {
      if (closedByCaller) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      attempt = 0; // reset backoff so the retry is immediate
      const stale = ws;
      ws = undefined; // supersede: the stale socket's onclose (ws !== sock) becomes a no-op
      try {
        stale?.close();
      } catch {
        /* already gone */
      }
      connect();
    },
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
