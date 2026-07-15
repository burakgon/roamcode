import { once } from "node:events";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { RelayHttpBridge, RelayHttpOpener } from "./relay-host.js";
import { relayRpcResponse } from "./relay-rpc.js";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface LoopbackRelayHttpOptions {
  baseUrl(): string | undefined;
  headers(token: string, requestHeaders: Record<string, string>): Record<string, string>;
  idleTimeoutMs?: number;
}

function loopbackBase(raw: string): URL {
  const base = new URL(raw);
  if (
    base.protocol !== "http:" ||
    (base.hostname !== "127.0.0.1" && base.hostname !== "[::1]" && base.hostname !== "::1")
  ) {
    throw new Error("relay HTTP bridge requires a loopback HTTP server");
  }
  return base;
}

function responseHeaders(streamId: string, status: number, headers: IncomingHttpHeaders): Record<string, string> {
  return relayRpcResponse({ id: streamId, status, headers }).headers;
}

/**
 * Streams an authenticated relay request through the real loopback HTTP server. This deliberately traverses
 * the normal auth, RBAC, rate-limit, idempotency, audit, multipart, and route hooks instead of calling file
 * services out of band.
 */
export function createLoopbackRelayHttpOpener(options: LoopbackRelayHttpOptions): RelayHttpOpener {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 5_000 || idleTimeoutMs > 10 * 60_000) {
    throw new Error("invalid relay HTTP idle timeout");
  }
  return async (token, transfer, handlers): Promise<RelayHttpBridge> => {
    const rawBase = options.baseUrl();
    if (!rawBase) throw new Error("relay HTTP loopback is not ready");
    const base = loopbackBase(rawBase);
    const url = new URL(transfer.path, base);
    if (url.origin !== base.origin) throw new Error("relay HTTP path escaped loopback");

    let closed = false;
    let responseStarted = false;
    const request = httpRequest(url, {
      method: transfer.method,
      headers: options.headers(token, transfer.headers),
    });
    request.setTimeout(idleTimeoutMs, () => request.destroy(new Error("relay HTTP request timed out")));

    const fail = (error: unknown) => {
      if (closed) return;
      closed = true;
      handlers.onError(error instanceof Error ? error : new Error("relay HTTP request failed"));
    };

    const streamResponse = async (response: IncomingMessage) => {
      if (closed) return;
      responseStarted = true;
      await handlers.onResponse({
        status: response.statusCode ?? 502,
        headers: responseHeaders(transfer.streamId, response.statusCode ?? 502, response.headers),
      });
      for await (const raw of response) {
        if (closed) return;
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        for (let offset = 0; offset < data.byteLength; offset += 64 * 1024) {
          await handlers.onData(data.subarray(offset, Math.min(data.byteLength, offset + 64 * 1024)));
        }
      }
      if (closed) return;
      closed = true;
      await handlers.onEnd();
    };

    request.once("response", (response) => {
      void streamResponse(response).catch(fail);
    });
    request.once("error", fail);
    request.once("close", () => {
      if (!closed && !responseStarted) fail(new Error("relay HTTP request closed before a response"));
    });

    return {
      async write(data) {
        if (closed || request.destroyed || request.writableEnded) throw new Error("relay HTTP upload is closed");
        if (request.write(data)) return;
        await once(request, "drain");
      },
      end() {
        if (closed || request.destroyed || request.writableEnded) return;
        request.end();
      },
      close() {
        if (closed) return;
        closed = true;
        request.destroy();
      },
    };
  };
}
