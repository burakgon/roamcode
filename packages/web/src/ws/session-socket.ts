import type { OutboundFrame, ServerFrame } from "../types/server";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SessionSocketOptions {
  url: string;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: SocketStatus) => void;
  /** Returns the last applied seq so a reconnect can request `?since=<seq>` delta replay. */
  getSince: () => number | undefined;
  /** Called when the server signals a `resync`: the reconnect replay buffer rotated PAST our `since`
   *  position, so some frames were evicted and a `?since=` delta can't recover them. The caller must
   *  refetch the full REST history to get whole again. The `resync` frame is consumed here (never
   *  surfaced via onFrame), so the conversation view is only ever rebuilt from the authoritative refetch. */
  onResync?: () => void;
  /** Injectable for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

export interface SessionSocket {
  /** Send a frame. Returns TRUE if it went out over the open socket now (delivered to the server), FALSE
   *  if it was buffered to flush on reconnect (offline / mid-reconnect). Lets the UI distinguish a
   *  delivered message from one still in transit. */
  send(frame: OutboundFrame): boolean;
  close(): void;
}

const MAX_BACKOFF_MS = 10000;

/**
 * Reconnecting per-session WebSocket. On an unexpected close it reconnects with exponential
 * backoff, rebuilding the URL with `?since=<lastSeq>` (from getSince) so the server replays
 * only the frames missed while disconnected (delta replay). It is online/offline aware: a
 * scheduled reconnect is skipped while offline and fires immediately when connectivity
 * returns. `close()` is final — it stops all reconnects and detaches listeners.
 */
export function createSessionSocket(opts: SessionSocketOptions): SessionSocket {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  let ws: WebSocket | undefined;
  let closedByUser = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Outbound frames sent while the socket is NOT open (mid-reconnect, or before the first open) are
  // QUEUED here, not dropped — the old code silently discarded them, so a message typed during a blip
  // vanished with no error and never reached Claude. They flush in order on the next open.
  let pending: OutboundFrame[] = [];

  function flushPending(): void {
    if (!ws || ws.readyState !== ws.OPEN) return;
    const queued = pending;
    pending = [];
    for (const frame of queued) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        pending.push(frame); // re-queue on a failed send; the next open retries it
      }
    }
  }

  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  const isOnline = (): boolean =>
    typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? navigator.onLine : true;

  function urlWithSince(): string {
    const since = opts.getSince();
    if (since === undefined) return opts.url;
    const sep = opts.url.includes("?") ? "&" : "?";
    // If the base url already carries a since, replace it; else append.
    return /[?&]since=/.test(opts.url)
      ? opts.url.replace(/([?&]since=)\d+/, `$1${since}`)
      : `${opts.url}${sep}since=${since}`;
  }

  function connect(): void {
    if (closedByUser) return;
    opts.onStatus("connecting");
    ws = new Impl(urlWithSince());
    ws.onopen = () => {
      attempt = 0;
      opts.onStatus("open");
      flushPending(); // deliver anything the user sent while we were reconnecting
    };
    ws.onmessage = (e: MessageEvent) => {
      try {
        const frame = JSON.parse(typeof e.data === "string" ? e.data : "") as ServerFrame;
        // `resync` is a control signal (the reconnect buffer rotated past our `since`): hand it to
        // onResync to trigger a full history refetch and never fold it into the conversation view.
        if (frame.kind === "resync") {
          opts.onResync?.();
          return;
        }
        opts.onFrame(frame);
      } catch {
        // ignore malformed frames (defensive; server frames are always JSON)
      }
    };
    ws.onclose = () => {
      if (closedByUser) {
        opts.onStatus("closed");
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; let it drive the reconnect.
    };
  }

  function scheduleReconnect(): void {
    if (closedByUser) return;
    opts.onStatus("connecting");
    // While offline, hold off — the `online` listener will trigger an immediate reconnect.
    if (!isOnline()) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function handleOnline(): void {
    if (closedByUser) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    attempt = 0;
    connect();
  }

  if (hasWindow) window.addEventListener("online", handleOnline);

  connect();

  return {
    send(frame: OutboundFrame): boolean {
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(frame));
          return true; // delivered to the server now
        } catch {
          pending.push(frame); // a racing close between the check and send → queue for the reconnect
          return false;
        }
      }
      pending.push(frame); // offline / mid-reconnect → hold it until the next open flushes
      return false;
    },
    close() {
      closedByUser = true;
      pending = []; // a deliberate close (session switch / unmount) drops anything unsent
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (hasWindow) window.removeEventListener("online", handleOnline);
      if (ws) ws.close();
      else opts.onStatus("closed");
    },
  };
}
