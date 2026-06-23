import type { OutboundFrame, ServerFrame } from "../types/server";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SessionSocketOptions {
  url: string;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: SocketStatus) => void;
  /** Returns the last applied seq so a reconnect can request `?since=<seq>` delta replay. */
  getSince: () => number | undefined;
  /** Injectable for tests; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

export interface SessionSocket {
  send(frame: OutboundFrame): void;
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
    };
    ws.onmessage = (e: MessageEvent) => {
      try {
        const frame = JSON.parse(typeof e.data === "string" ? e.data : "") as ServerFrame;
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
    send(frame: OutboundFrame) {
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    close() {
      closedByUser = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (hasWindow) window.removeEventListener("online", handleOnline);
      if (ws) ws.close();
      else opts.onStatus("closed");
    },
  };
}
