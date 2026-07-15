import WebSocket from "ws";
import type { RelayTerminalBridge, RelayTerminalOpener } from "./relay-host.js";

const LOCAL_TERMINAL_MAX_BUFFER = 4 * 1024 * 1024;

export interface LoopbackRelayTerminalOptions {
  baseUrl(): string | undefined;
  issueTicket(token: string): Promise<string>;
  WebSocketClass?: typeof WebSocket;
  openTimeoutMs?: number;
}

function terminalUrl(baseUrl: string, request: Parameters<RelayTerminalOpener>[1], ticket: string): string {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "http:" ||
    (base.hostname !== "127.0.0.1" && base.hostname !== "[::1]" && base.hostname !== "::1")
  ) {
    throw new Error("relay terminal bridge requires a loopback HTTP server");
  }
  base.protocol = "ws:";
  base.pathname = `/sessions/${encodeURIComponent(request.sessionId)}/terminal`;
  const query = new URLSearchParams({ ticket });
  if (request.cols !== undefined) query.set("cols", String(request.cols));
  if (request.rows !== undefined) query.set("rows", String(request.rows));
  if (request.respawn) query.set("respawn", request.respawn);
  base.search = query.toString();
  return base.href;
}

export function createLoopbackRelayTerminalOpener(options: LoopbackRelayTerminalOptions): RelayTerminalOpener {
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  const openTimeoutMs = options.openTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1_000 || openTimeoutMs > 30_000) {
    throw new Error("invalid relay terminal open timeout");
  }
  return async (token, request, handlers): Promise<RelayTerminalBridge> => {
    const baseUrl = options.baseUrl();
    if (!baseUrl) throw new Error("relay terminal loopback is not ready");
    const ticket = await options.issueTicket(token);
    const socket = new WebSocketClass(terminalUrl(baseUrl, request, ticket));
    socket.binaryType = "arraybuffer";
    let settled = false;
    let closed = false;
    const bridge: RelayTerminalBridge = {
      send(data) {
        if (closed || socket.readyState !== WebSocketClass.OPEN || socket.bufferedAmount > LOCAL_TERMINAL_MAX_BUFFER) {
          throw new Error("relay terminal loopback is unavailable");
        }
        socket.send(data);
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          socket.close(1000, "relay stream closed");
        } catch {
          /* already closed */
        }
      },
    };
    return new Promise<RelayTerminalBridge>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        bridge.close();
        reject(new Error("relay terminal loopback timed out"));
      }, openTimeoutMs);
      timer.unref?.();
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(bridge);
      });
      socket.on("message", (raw, isBinary) => {
        if (closed) return;
        if (isBinary) {
          const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
          handlers.onBinary(bytes);
          return;
        }
        const text = Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString("utf8")
            : Buffer.concat(raw).toString("utf8");
        handlers.onControl(text);
      });
      socket.once("close", (code) => {
        closed = true;
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error("relay terminal loopback closed before opening"));
          return;
        }
        handlers.onClose(code);
      });
      socket.once("error", () => {
        /* close owns rejection and lifecycle */
      });
    });
  };
}
