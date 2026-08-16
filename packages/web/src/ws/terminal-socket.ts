export interface TerminalSocket {
  sendInput(d: string): void;
  sendResize(cols: number, rows: number): void;
  /** Force an immediate reconnect and reset the backoff — for a manual "Reconnect now" tap or a back-online
   *  event, so the user isn't stuck waiting out the (up to 15s) backoff after the phone wakes. */
  reconnect(): void;
  /** Keep the server's notification gate aligned with the real foreground/focus state. */
  setVisibility?(visible: boolean): void;
  close(): void;
}

/** Connection lifecycle surfaced to the view. `reconnecting` = a transient drop, auto-retrying; `ended` =
 *  a terminal state (claude exited or the session is gone) — no retry, the view offers Restart/Close. */
export type TerminalStatus = "open" | "reconnecting" | "ended";

/**
 * WHY the connection is in its current state. Every close used to collapse into the same two words —
 * "Reconnecting…" forever, or an "exited" card that guessed at a sign-out — because the server's close code
 * and reason were discarded. Optional: the ordinary cases (a clean exit, a first blip) carry no detail and
 * the view keeps its default copy.
 */
export interface TerminalStatusDetail {
  cause:
    | "session-gone" // 4404: the server has no such terminal session
    | "session-exited" // 4410: the shell/agent exited normally
    | "attach-failed" // 4404 + reason: the session exists but could not be attached
    | "access-revoked" // 4403: this device's credential was revoked
    | "unreachable"; // repeated failures: not a blip any more
  /** Server specifics for `attach-failed` (e.g. "cwd-missing", "terminal-unavailable"). */
  detail?: string;
  /** Consecutive failed connection attempts, for `unreachable`. */
  attempts?: number;
}

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
  onData: (bytes: Uint8Array, onParsed?: () => void) => void;
  /** `detail` explains an unusual status; ordinary transitions omit it. */
  onStatus?: (s: TerminalStatus, detail?: TerminalStatusDetail) => void;
  /** Out-of-band control messages (JSON text frames) — file/image attachments claude sent. The server
   *  sends pty output as BINARY frames and control as TEXT frames, so we split by frame type. */
  onControl?: (json: string) => void;
  /** Read the page's current focus at each successful (re)connect. */
  isVisible?: () => boolean;
}

// Server close codes that are FATAL (do not reconnect): 4410 = session ended (claude exited), 4404 =
// session not found / attach failed, 4403 = this device's access was revoked. Retrying any of them can only
// fail the same way — 4403 in particular used to reconnect forever behind an eternal "Reconnecting…".
// Anything else (network drop, server restart, 1006) is transient → reconnect.
const FATAL_CLOSE_CODES = new Set([4403, 4404, 4410]);

/** Consecutive failed attempts before a drop stops being described as a blip. The backoff itself is
 *  unchanged and never gives up — a phone in a tunnel must still recover — but after this many failures the
 *  view is told the Node is unreachable instead of repeating "Reconnecting…" indefinitely. */
const UNREACHABLE_AFTER_ATTEMPTS = 4;

function isTerminalFlowConfirmation(frame: string): boolean {
  try {
    const value = JSON.parse(frame) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const confirmation = value as Record<string, unknown>;
    return (
      confirmation.t === "terminal-flow" &&
      confirmation.v === 1 &&
      confirmation.high === 262_144 &&
      confirmation.low === 65_536 &&
      confirmation.chunk === 65_536
    );
  } catch {
    return false;
  }
}

/** Read the server's close code + reason into a cause the view can actually explain. The reason string for a
 *  failed attach is `attach-failed[:specifics]`; everything else is identified by code alone. */
function closeDetail(code: number, reason: string): TerminalStatusDetail | undefined {
  if (code === 4403) return { cause: "access-revoked" };
  if (code === 4410) return { cause: "session-exited" };
  if (code === 4404) {
    if (reason.startsWith("attach-failed")) {
      const detail = reason.slice("attach-failed".length).replace(/^:/, "");
      return { cause: "attach-failed", ...(detail ? { detail } : {}) };
    }
    return { cause: "session-gone" };
  }
  return undefined;
}

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
  let visible = opts.isVisible?.() ?? true;

  const scheduleRetry = () => {
    // Transient drop / failed URL build → back off and retry (0.5s, 1s, 2s, … capped at 15s, + jitter).
    // Past UNREACHABLE_AFTER_ATTEMPTS this is no longer a blip, and saying so is the difference between "wait
    // a moment" and "your Node is down" — the retry loop itself continues either way.
    opts.onStatus?.(
      "reconnecting",
      attempt >= UNREACHABLE_AFTER_ATTEMPTS ? { cause: "unreachable", attempts: attempt } : undefined,
    );
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
    let flowEnabled = false;
    let parsedBytes = 0;
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      visible = opts.isVisible?.() ?? visible;
      sock.send(JSON.stringify({ t: "v", v: visible }));
      opts.onStatus?.("open");
    };
    sock.onmessage = (e: MessageEvent) => {
      if (closedByCaller || ws !== sock) return;
      // BINARY = raw pty output; TEXT (string) = a control frame (attachment JSON).
      let bytes: Uint8Array | undefined;
      if (e.data instanceof ArrayBuffer) bytes = new Uint8Array(e.data);
      else if (typeof e.data === "object" && e.data !== null && "byteLength" in e.data) bytes = new Uint8Array(e.data);
      if (bytes) {
        const byteLength = bytes.byteLength;
        let completed = false;
        opts.onData(bytes, () => {
          if (completed) return;
          completed = true;
          if (closedByCaller || ws !== sock || sock.readyState !== sock.OPEN || !flowEnabled) return;
          parsedBytes += byteLength;
          sock.send(JSON.stringify({ t: "a", n: parsedBytes }));
        });
      } else if (typeof e.data === "string") {
        if (isTerminalFlowConfirmation(e.data)) {
          flowEnabled = true;
          return;
        }
        opts.onControl?.(e.data);
      }
    };
    sock.onerror = () => {
      /* the close event follows and drives reconnect/ended */
    };
    sock.onclose = (e: CloseEvent) => {
      if (closedByCaller || ws !== sock) return; // superseded or intentionally closed
      if (FATAL_CLOSE_CODES.has(e.code)) {
        opts.onStatus?.("ended", closeDetail(e.code, e.reason ?? ""));
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
    setVisibility: (next) => {
      visible = next;
      openSend({ t: "v", v: next });
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
