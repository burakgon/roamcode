import {
  BrowserRelayCryptoError,
  browserRelayIdentityFingerprint,
  createBrowserRelayHandshakeHello,
  establishBrowserRelayChannel,
  type BrowserRelayCipherState,
  type BrowserRelayIdentity,
  type RelayFrameKind,
} from "./crypto";
import { decodeRelayWireEnvelope, encodeRelayWireEnvelope } from "./wire";

const RPC_MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const HTTP_STREAM_IDLE_TIMEOUT_MS = 120_000;
const HTTP_STREAM_WINDOW_BYTES = 512 * 1024;
const HTTP_STREAM_CHUNK_BYTES = 64 * 1024;
const HTTP_STREAM_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "if-none-match",
  "if-range",
  "last-event-id",
  "range",
]);

export type BrowserRelayStatus =
  "idle" | "connecting" | "online" | "reconnecting" | "revoked" | "superseded" | "error" | "closed";

export interface BrowserRelayClientOptions {
  relayUrl: string;
  routeId: string;
  deviceId: string;
  deviceCredential: string;
  deviceToken: string;
  identity: BrowserRelayIdentity;
  hostIdentityPublicKey: string;
  webSocketFactory?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
  onStatus?: (status: BrowserRelayStatus) => void;
  /** One-use E2E bootstrap. The durable routing credential is generated in-browser and never enters the link. */
  pairing?: { secret: string; name: string; relayCredential: string; onPaired?: () => void };
  /**
   * Account-driven enrollment. Every raw credential stays inside the pinned E2E channel; the account
   * service and relay broker receive only hashes and public identity material.
   */
  cloudEnrollment?: {
    enrollmentId: string;
    challenge: string;
    name: string;
    durableRelayCredential: string;
    onEnrolled?: () => void;
  };
}

export interface BrowserRelayClient {
  start(): void;
  ready(timeoutMs?: number): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  upload(
    input: RequestInfo | URL,
    init: RequestInit,
    onProgress: (fraction: number) => void,
    contentBytes: number,
  ): { abort(): void; promise: Promise<Response> };
  openTerminal(options: BrowserRelayTerminalOptions): BrowserRelayTerminalSocket;
  reconnect(): void;
  close(): void;
  status(): BrowserRelayStatus;
}

export type BrowserRelayTerminalStatus = "open" | "reconnecting" | "ended";

export interface BrowserRelayTerminalOptions {
  sessionId: string;
  cols?: number;
  rows?: number;
  respawn?: "continue" | "fresh";
  onData(data: Uint8Array): void;
  onControl?(data: string): void;
  onStatus?(status: BrowserRelayTerminalStatus): void;
}

export interface BrowserRelayTerminalSocket {
  sendInput(data: string): void;
  sendResize(cols: number, rows: number): void;
  requestInputLease(action: "acquire" | "takeover" | "renew" | "release", confirm?: boolean): void;
  reconnect(): void;
  close(): void;
}

export function browserRelayAuthenticationPayload(input: {
  deviceToken: string;
  deviceCredential: string;
  pairing?: BrowserRelayClientOptions["pairing"];
  cloudEnrollment?: BrowserRelayClientOptions["cloudEnrollment"];
}): Record<string, unknown> {
  return {
    token: input.deviceToken,
    relayCredential:
      input.pairing?.relayCredential ?? input.cloudEnrollment?.durableRelayCredential ?? input.deviceCredential,
    ...(input.pairing ? { pairing: { secret: input.pairing.secret, name: input.pairing.name } } : {}),
    ...(input.cloudEnrollment
      ? {
          cloudEnrollment: {
            v: 1,
            kind: "cloud-device-enrollment",
            enrollmentId: input.cloudEnrollment.enrollmentId,
            challenge: input.cloudEnrollment.challenge,
            name: input.cloudEnrollment.name,
            localDeviceToken: input.deviceToken,
            durableRelayCredential: input.cloudEnrollment.durableRelayCredential,
          },
        }
      : {}),
  };
}

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

interface RelayTerminalRecord extends BrowserRelayTerminalOptions {
  id: string;
  opened: boolean;
  closed: boolean;
}

interface RelayHttpRecord {
  id: string;
  request: Request;
  resolve(response: Response): void;
  reject(error: Error): void;
  responseResolved: boolean;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  requestReader?: ReadableStreamDefaultReader<Uint8Array>;
  requestCredit: number;
  requestCreditWaiters: Set<() => void>;
  responseCreditOutstanding: number;
  responseBytes: number;
  expectedResponseBytes?: number;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  uploadProgress?: { contentBytes: number; onProgress(fraction: number): void };
  closed: boolean;
}

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid relay ${field}`);
  return value;
}

function loopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function browserRelayConnectUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Relay URL cannot contain credentials, a query, or a fragment.");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("Relay URL must use HTTPS or WSS.");
  if (url.protocol === "ws:" && !loopback(url.hostname)) throw new Error("A remote relay must use TLS.");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/connect";
  else if (url.pathname.replace(/\/$/, "") !== "/v1/connect") throw new Error("Relay URL path must be /v1/connect.");
  return url.href;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, Math.min(value.byteLength, offset + 0x8000)));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Generate the durable broker capability locally so a copied bootstrap link loses routing access when it expires. */
export function generateBrowserRelayDeviceCredential(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `rrd_${encodeBase64Url(bytes)}`;
}

function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const binary = atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function responseFrom(value: unknown): { id: string; response: Response } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay RPC response");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.id) ||
    !Number.isSafeInteger(record.status) ||
    (record.status as number) < 100 ||
    (record.status as number) > 599 ||
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers)
  ) {
    throw new Error("invalid relay RPC response");
  }
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(record.headers as Record<string, unknown>)) {
    if (typeof headerValue !== "string" || name !== name.toLowerCase() || /[\r\n\u0000]/.test(headerValue)) {
      throw new Error("invalid relay RPC response headers");
    }
    headers.set(name, headerValue);
  }
  const body = record.body === undefined ? undefined : decodeBase64Url(record.body);
  if (record.body !== undefined && !body) throw new Error("invalid relay RPC response body");
  const status = record.status as number;
  return {
    id: record.id,
    response: new Response(status === 204 || status === 304 || body?.byteLength === 0 ? undefined : body, {
      status,
      headers,
    }),
  };
}

function responseHeadFrom(value: unknown): { id: string; status: number; headers: Headers } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay HTTP response");
  const record = value as Record<string, unknown>;
  if (
    record.type !== "http" ||
    record.ok !== true ||
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.id) ||
    !Number.isSafeInteger(record.status) ||
    (record.status as number) < 100 ||
    (record.status as number) > 599 ||
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers)
  ) {
    throw new Error("invalid relay HTTP response");
  }
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(record.headers as Record<string, unknown>)) {
    if (typeof headerValue !== "string" || name !== name.toLowerCase() || /[\r\n\u0000]/.test(headerValue)) {
      throw new Error("invalid relay HTTP response headers");
    }
    headers.set(name, headerValue);
  }
  return { id: record.id, status: record.status as number, headers };
}

function responseContentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9]\d{0,15})$/.test(raw)) throw new Error("invalid relay HTTP content length");
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid relay HTTP content length");
  return length;
}

function shouldStreamHttp(request: Request): boolean {
  const url = new URL(request.url);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const declared = Number(request.headers.get("content-length"));
  return (
    url.pathname === "/fs/download" ||
    /^\/sessions\/[^/]+\/files\/[^/]+\/content$/.test(url.pathname) ||
    url.pathname.startsWith("/images/") ||
    contentType.startsWith("multipart/form-data") ||
    contentType.startsWith("application/octet-stream") ||
    (Number.isFinite(declared) && declared > RPC_MAX_BODY_BYTES)
  );
}

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    // The device token authenticates the encrypted channel once. Never forward Authorization as RPC metadata.
    if (name === "authorization") return;
    // The loopback request is chunked and computes its own framing. A browser-provided length could become stale.
    if (name === "content-length") return;
    if (!REQUEST_HEADERS.has(name) || value.length > 2048 || /[\r\n\u0000]/.test(value)) {
      throw new Error(`Header ${name} is unavailable over relay.`);
    }
    headers[name] = value;
  });
  return headers;
}

export function createBrowserRelayClient(options: BrowserRelayClientOptions): BrowserRelayClient {
  const relayUrl = browserRelayConnectUrl(options.relayUrl);
  const routeId = safeId(options.routeId, "route id");
  const deviceId = safeId(options.deviceId, "device id");
  if (!/^rrd_[A-Za-z0-9_-]{43}$/.test(options.deviceCredential)) throw new Error("invalid relay device credential");
  if (!options.deviceToken || options.deviceToken.length > 4096) throw new Error("invalid relay device token");
  if (
    options.pairing &&
    (!/^rcp_[A-Za-z0-9_-]{43}$/.test(options.pairing.secret) ||
      !options.pairing.name.trim() ||
      options.pairing.name.length > 80 ||
      !/^rrd_[A-Za-z0-9_-]{43}$/.test(options.pairing.relayCredential) ||
      options.pairing.relayCredential === options.deviceCredential)
  )
    throw new Error("invalid relay pairing capability");
  if (options.pairing && options.cloudEnrollment) throw new Error("relay bootstrap modes are mutually exclusive");
  if (
    options.cloudEnrollment &&
    (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.cloudEnrollment.enrollmentId,
    ) ||
      !/^rce_[A-Za-z0-9_-]{43}$/.test(options.cloudEnrollment.challenge) ||
      !options.cloudEnrollment.name.trim() ||
      options.cloudEnrollment.name.length > 80 ||
      !/^rrd_[A-Za-z0-9_-]{43}$/.test(options.cloudEnrollment.durableRelayCredential) ||
      options.cloudEnrollment.durableRelayCredential === options.deviceCredential ||
      !/^rcd_[A-Za-z0-9_-]{43}$/.test(options.deviceToken))
  )
    throw new Error("invalid cloud enrollment capability");
  const createSocket = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let state: BrowserRelayStatus = "idle";
  let socket: WebSocket | undefined;
  let cipher: BrowserRelayCipherState | undefined;
  let deviceHello: Awaited<ReturnType<typeof createBrowserRelayHandshakeHello>> | undefined;
  let pinnedHostFingerprint: string | undefined;
  let pairing = options.pairing;
  let cloudEnrollment = options.cloudEnrollment;
  let phase: "broker" | "handshake" | "auth" | "ready" = "broker";
  let closed = false;
  let generation = 0;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let receiveQueue = Promise.resolve();
  let sendQueue = Promise.resolve();
  const pending = new Map<string, PendingRequest>();
  const terminals = new Map<string, RelayTerminalRecord>();
  const httpStreams = new Map<string, RelayHttpRecord>();
  const readyWaiters = new Set<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  const setState = (next: BrowserRelayStatus) => {
    if (state === next) return;
    state = next;
    options.onStatus?.(next);
    if (next === "online") {
      for (const waiter of readyWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      readyWaiters.clear();
    }
  };

  const rejectPending = (message: string) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.abort?.();
      item.reject(new TypeError(message));
    }
    pending.clear();
  };

  const sendBroker = (value: unknown): boolean => {
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 4_000_000) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };

  const sendEncrypted = (kind: RelayFrameKind, value: unknown): Promise<void> => {
    const work = sendQueue.then(async () => {
      if (!cipher || (phase !== "ready" && kind !== "auth")) throw new Error("relay channel is not ready");
      const deadline = Date.now() + REQUEST_TIMEOUT_MS;
      while (socket && socket.bufferedAmount > 1024 * 1024) {
        if (closed || Date.now() >= deadline) throw new Error("relay remained backpressured");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (!cipher || (phase !== "ready" && kind !== "auth")) throw new Error("relay channel is not ready");
      const frame = await cipher.encrypt(kind, new TextEncoder().encode(JSON.stringify(value)));
      if (!sendBroker({ t: "frame", payload: encodeRelayWireEnvelope({ v: 1, t: "cipher", frame }) })) {
        throw new Error("relay is unavailable");
      }
    });
    sendQueue = work.catch(() => undefined);
    return work;
  };

  const touchHttpStream = (stream: RelayHttpRecord) => {
    if (stream.timer) clearTimeout(stream.timer);
    if (stream.closed) return;
    stream.timer = setTimeout(() => {
      if (phase === "ready") void sendEncrypted("close", { id: stream.id, code: 1008 }).catch(() => undefined);
      failHttpStream(stream, "Relay file transfer timed out.");
    }, HTTP_STREAM_IDLE_TIMEOUT_MS);
  };

  const failHttpStream = (stream: RelayHttpRecord, message: string) => {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
    stream.abort?.();
    stream.abort = undefined;
    void stream.requestReader?.cancel().catch(() => undefined);
    stream.requestReader = undefined;
    for (const wake of stream.requestCreditWaiters) wake();
    stream.requestCreditWaiters.clear();
    if (httpStreams.get(stream.id) === stream) httpStreams.delete(stream.id);
    const error = new TypeError(message);
    if (stream.responseResolved) {
      try {
        stream.controller?.error(error);
      } catch {
        /* response body already closed */
      }
    } else {
      stream.reject(error);
    }
  };

  const finishHttpStream = (stream: RelayHttpRecord) => {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = undefined;
    stream.abort?.();
    stream.abort = undefined;
    stream.requestReader = undefined;
    stream.requestCreditWaiters.clear();
    if (httpStreams.get(stream.id) === stream) httpStreams.delete(stream.id);
  };

  const rejectHttpStreams = (message: string) => {
    for (const stream of [...httpStreams.values()]) failHttpStream(stream, message);
  };

  const waitForRequestCredit = async (stream: RelayHttpRecord) => {
    while (!stream.closed && stream.requestCredit <= 0) {
      await new Promise<void>((resolve) => stream.requestCreditWaiters.add(resolve));
    }
    if (stream.closed) throw new Error("relay HTTP request stream closed");
  };

  const grantResponseCredit = (stream: RelayHttpRecord) => {
    if (stream.closed || !stream.controller || phase !== "ready") return;
    const desired = Math.max(0, Math.floor(stream.controller.desiredSize ?? 0));
    const target = Math.min(HTTP_STREAM_WINDOW_BYTES, desired);
    const grant = target - stream.responseCreditOutstanding;
    if (grant <= 0) return;
    stream.responseCreditOutstanding += grant;
    void sendEncrypted("stream-control", { id: stream.id, event: "response-credit", bytes: grant }).catch(() => {
      failHttpStream(stream, "Relay file transfer could not continue.");
    });
  };

  const streamHttpRequest = (request: Request, uploadProgress?: RelayHttpRecord["uploadProgress"]): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const id = `http-${globalThis.crypto.randomUUID?.() ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
      const stream: RelayHttpRecord = {
        id,
        request,
        resolve,
        reject,
        responseResolved: false,
        requestCredit: 0,
        requestCreditWaiters: new Set(),
        responseCreditOutstanding: 0,
        responseBytes: 0,
        ...(uploadProgress ? { uploadProgress } : {}),
        closed: false,
      };
      const abort = () => {
        if (phase === "ready") void sendEncrypted("close", { id, code: 1000 }).catch(() => undefined);
        failHttpStream(stream, "Relay file transfer was cancelled.");
      };
      if (request.signal.aborted) {
        reject(
          request.signal.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"),
        );
        return;
      }
      request.signal.addEventListener("abort", abort, { once: true });
      stream.abort = () => request.signal.removeEventListener("abort", abort);
      httpStreams.set(id, stream);
      touchHttpStream(stream);

      void (async () => {
        const url = new URL(request.url);
        await sendEncrypted("stream-open", {
          id,
          type: "http",
          method: request.method.toUpperCase(),
          path: `${url.pathname}${url.search}`,
          headers: requestHeaders(request),
        });
        const reader = request.body?.getReader();
        stream.requestReader = reader;
        let sent = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < value.byteLength;) {
              await waitForRequestCredit(stream);
              const size = Math.min(HTTP_STREAM_CHUNK_BYTES, stream.requestCredit, value.byteLength - offset);
              if (sent + size > HTTP_STREAM_MAX_REQUEST_BYTES) {
                throw new TypeError("This request is too large for the encrypted relay.");
              }
              const chunk = value.subarray(offset, offset + size);
              stream.requestCredit -= size;
              sent += size;
              await sendEncrypted("stream-data", { id, data: encodeBase64Url(chunk) });
              stream.uploadProgress?.onProgress(Math.min(0.99, sent / Math.max(1, stream.uploadProgress.contentBytes)));
              touchHttpStream(stream);
              offset += size;
            }
          }
        }
        stream.requestReader = undefined;
        await sendEncrypted("stream-control", { id, event: "request-end", bytes: sent });
        touchHttpStream(stream);
      })().catch((error: unknown) => {
        if (phase === "ready") void sendEncrypted("close", { id, code: 1011 }).catch(() => undefined);
        failHttpStream(stream, error instanceof Error ? error.message : "Relay file transfer could not be sent.");
      });
    });

  const openTerminalStream = (terminal: RelayTerminalRecord): void => {
    if (terminal.closed || phase !== "ready") return;
    terminal.opened = false;
    terminal.onStatus?.("reconnecting");
    void sendEncrypted("stream-open", {
      id: terminal.id,
      sessionId: safeId(terminal.sessionId, "session id"),
      ...(terminal.cols === undefined ? {} : { cols: terminal.cols }),
      ...(terminal.rows === undefined ? {} : { rows: terminal.rows }),
      ...(terminal.respawn ? { respawn: terminal.respawn } : {}),
    }).catch(() => terminal.onStatus?.("reconnecting"));
  };

  const reopenTerminals = () => {
    for (const terminal of terminals.values()) openTerminalStream(terminal);
  };

  const fatal = (next: BrowserRelayStatus, message: string) => {
    generation += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (pingTimer) clearInterval(pingTimer);
    reconnectTimer = undefined;
    handshakeTimer = undefined;
    pingTimer = undefined;
    cipher?.close();
    cipher = undefined;
    rejectPending(message);
    rejectHttpStreams(message);
    for (const terminal of terminals.values()) {
      terminal.opened = false;
      terminal.onStatus?.("ended");
    }
    setState(next);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    socket = undefined;
    for (const waiter of readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    readyWaiters.clear();
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer || state === "revoked" || state === "superseded" || state === "error") return;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (pingTimer) clearInterval(pingTimer);
    handshakeTimer = undefined;
    pingTimer = undefined;
    cipher?.close();
    cipher = undefined;
    rejectPending("Relay connection was interrupted.");
    rejectHttpStreams("Relay file transfer was interrupted. Try again to resume it.");
    for (const terminal of terminals.values()) {
      terminal.opened = false;
      terminal.onStatus?.("reconnecting");
    }
    setState("reconnecting");
    const delay = Math.min(15_000, 500 * 2 ** attempt) + Math.floor(random() * 250);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const handleBrokerMessage = async (message: Record<string, unknown>) => {
    if (message.t === "pong") return;
    if (message.t === "ready" && message.role === "device" && phase === "broker") {
      deviceHello = await createBrowserRelayHandshakeHello({
        role: "device",
        routeId,
        deviceId,
        identity: options.identity,
      });
      phase = "handshake";
      if (
        !sendBroker({
          t: "frame",
          payload: encodeRelayWireEnvelope({
            v: 1,
            t: "device-hello",
            hello: deviceHello.hello,
            identityPublicKey: options.identity.publicKey,
          }),
        })
      ) {
        throw new Error("relay is unavailable");
      }
      return;
    }
    if (message.t !== "frame") throw new Error("unexpected relay broker message");
    const envelope = decodeRelayWireEnvelope(message.payload);
    if (phase === "handshake") {
      if (envelope.t !== "host-hello" || !deviceHello) throw new Error("host handshake required");
      cipher = await establishBrowserRelayChannel({
        role: "device",
        localEphemeral: deviceHello.ephemeral,
        deviceHello: deviceHello.hello,
        hostHello: envelope.hello,
        deviceIdentityPublicKey: options.identity.publicKey,
        hostIdentityPublicKey: options.hostIdentityPublicKey,
        now,
      });
      pinnedHostFingerprint = await browserRelayIdentityFingerprint(options.hostIdentityPublicKey);
      phase = "auth";
      await sendEncrypted(
        "auth",
        browserRelayAuthenticationPayload({
          deviceToken: options.deviceToken,
          deviceCredential: options.deviceCredential,
          ...(pairing ? { pairing } : {}),
          ...(cloudEnrollment ? { cloudEnrollment } : {}),
        }),
      );
      return;
    }
    if (envelope.t !== "cipher" || !cipher) throw new Error("encrypted relay frame required");
    const plaintext = await cipher.decrypt(envelope.frame);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } finally {
      plaintext.fill(0);
    }
    if (phase === "auth") {
      const auth = value as { ok?: unknown; deviceId?: unknown; hostIdentityFingerprint?: unknown };
      if (
        envelope.frame.kind !== "auth" ||
        auth?.ok !== true ||
        auth.deviceId !== deviceId ||
        auth.hostIdentityFingerprint !== pinnedHostFingerprint
      ) {
        throw new Error("relay authentication failed");
      }
      phase = "ready";
      if (pairing) {
        pairing.onPaired?.();
        pairing = undefined;
      }
      if (cloudEnrollment) {
        cloudEnrollment.onEnrolled?.();
        cloudEnrollment = undefined;
      }
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
      attempt = 0;
      setState("online");
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => sendBroker({ t: "ping" }), PING_INTERVAL_MS);
      reopenTerminals();
      return;
    }
    if (phase !== "ready") throw new Error("unexpected relay frame");
    if (envelope.frame.kind === "stream-open") {
      const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const http = typeof raw.id === "string" && raw.type === "http" ? httpStreams.get(raw.id) : undefined;
      if (http) {
        if (raw.ok !== true) {
          failHttpStream(http, "The host could not open this encrypted file transfer.");
          return;
        }
        if (http.responseResolved) throw new Error("duplicate relay HTTP response");
        const head = responseHeadFrom(value);
        const expected = responseContentLength(head.headers);
        const hasBody =
          http.request.method !== "HEAD" && head.status !== 204 && head.status !== 205 && head.status !== 304;
        let body: ReadableStream<Uint8Array> | undefined;
        if (hasBody) {
          body = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                http.controller = controller;
              },
              pull() {
                grantResponseCredit(http);
              },
              cancel() {
                if (phase === "ready") void sendEncrypted("close", { id: http.id, code: 1000 }).catch(() => undefined);
                finishHttpStream(http);
              },
            },
            {
              highWaterMark: HTTP_STREAM_WINDOW_BYTES,
              size: (chunk) => chunk.byteLength,
            },
          );
        }
        http.expectedResponseBytes = expected;
        http.responseResolved = true;
        http.uploadProgress?.onProgress(1);
        http.resolve(new Response(body, { status: head.status, headers: head.headers }));
        touchHttpStream(http);
        if (body) grantResponseCredit(http);
        return;
      }
      const result = value as { id?: unknown; ok?: unknown };
      const terminal = typeof result?.id === "string" ? terminals.get(result.id) : undefined;
      if (!terminal || terminal.closed || typeof result.ok !== "boolean")
        throw new Error("invalid terminal open response");
      terminal.opened = result.ok;
      terminal.onStatus?.(result.ok ? "open" : "ended");
      return;
    }
    if (envelope.frame.kind === "stream-data") {
      const output = value as { id?: unknown; data?: unknown };
      const http = typeof output?.id === "string" ? httpStreams.get(output.id) : undefined;
      if (http) {
        const data = decodeBase64Url(output.data);
        if (
          http.closed ||
          !http.responseResolved ||
          !http.controller ||
          !data ||
          data.byteLength > HTTP_STREAM_CHUNK_BYTES ||
          data.byteLength > http.responseCreditOutstanding
        ) {
          throw new Error("invalid relay HTTP response data");
        }
        http.responseCreditOutstanding -= data.byteLength;
        http.responseBytes += data.byteLength;
        if (http.expectedResponseBytes !== undefined && http.responseBytes > http.expectedResponseBytes) {
          throw new Error("relay HTTP response exceeded its declared length");
        }
        http.controller.enqueue(data);
        touchHttpStream(http);
        if (http.expectedResponseBytes === undefined || http.responseBytes < http.expectedResponseBytes) {
          grantResponseCredit(http);
        }
        return;
      }
      const terminal = typeof output?.id === "string" ? terminals.get(output.id) : undefined;
      const data = decodeBase64Url(output?.data);
      if (!terminal || terminal.closed || !data) throw new Error("invalid terminal output");
      terminal.onData(data);
      return;
    }
    if (envelope.frame.kind === "stream-control") {
      const output = value as { id?: unknown; data?: unknown };
      const http = typeof output?.id === "string" ? httpStreams.get(output.id) : undefined;
      if (http) {
        const control = value as { event?: unknown; bytes?: unknown };
        if (control.event === "request-credit") {
          if (
            !Number.isSafeInteger(control.bytes) ||
            (control.bytes as number) < 1 ||
            (control.bytes as number) > HTTP_STREAM_WINDOW_BYTES ||
            http.requestCredit + (control.bytes as number) > HTTP_STREAM_WINDOW_BYTES
          ) {
            throw new Error("invalid relay HTTP request credit");
          }
          http.requestCredit += control.bytes as number;
          for (const wake of http.requestCreditWaiters) wake();
          http.requestCreditWaiters.clear();
          touchHttpStream(http);
          return;
        }
        if (control.event === "response-end") {
          if (
            !http.responseResolved ||
            control.bytes !== http.responseBytes ||
            (http.expectedResponseBytes !== undefined && http.responseBytes !== http.expectedResponseBytes)
          ) {
            throw new Error("relay HTTP response length mismatch");
          }
          try {
            http.controller?.close();
          } finally {
            finishHttpStream(http);
          }
          return;
        }
        throw new Error("invalid relay HTTP stream control");
      }
      const terminal = typeof output?.id === "string" ? terminals.get(output.id) : undefined;
      if (!terminal || terminal.closed || typeof output.data !== "string") throw new Error("invalid terminal control");
      terminal.onControl?.(output.data);
      return;
    }
    if (envelope.frame.kind === "close") {
      const output = value as { id?: unknown; code?: unknown };
      const http = typeof output?.id === "string" ? httpStreams.get(output.id) : undefined;
      if (http) {
        if (!Number.isSafeInteger(output.code)) throw new Error("invalid relay HTTP close");
        failHttpStream(http, "The encrypted file transfer ended before completion.");
        return;
      }
      const terminal = typeof output?.id === "string" ? terminals.get(output.id) : undefined;
      if (!terminal || terminal.closed || !Number.isSafeInteger(output.code)) throw new Error("invalid terminal close");
      terminal.opened = false;
      terminal.onStatus?.("ended");
      return;
    }
    if (envelope.frame.kind !== "rpc-response") throw new Error("unexpected relay frame");
    const { id, response } = responseFrom(value);
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    item.abort?.();
    item.resolve(response);
  };

  const connect = () => {
    if (closed) return;
    const currentGeneration = ++generation;
    phase = "broker";
    receiveQueue = Promise.resolve();
    sendQueue = Promise.resolve();
    deviceHello = undefined;
    setState(attempt > 0 ? "reconnecting" : "connecting");
    let next: WebSocket;
    try {
      next = createSocket(relayUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;
    next.addEventListener("open", () => {
      if (closed || generation !== currentGeneration) return;
      if (
        !sendBroker({
          v: 1,
          role: "device",
          routeId,
          deviceId,
          credential: options.deviceCredential,
        })
      ) {
        next.close();
      }
    });
    next.addEventListener("message", (event) => {
      if (closed || generation !== currentGeneration) return;
      receiveQueue = receiveQueue
        .then(async () => {
          if (typeof event.data !== "string") throw new Error("relay broker messages must be text");
          const message = JSON.parse(event.data) as unknown;
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            throw new Error("invalid relay broker message");
          }
          await handleBrokerMessage(message as Record<string, unknown>);
        })
        .catch((error) => {
          const securityFailure = error instanceof BrowserRelayCryptoError;
          fatal(securityFailure ? "error" : "error", "Relay security handshake failed.");
        });
    });
    next.addEventListener("close", (event) => {
      if (generation !== currentGeneration || closed) return;
      socket = undefined;
      if (event.code === 4401 || event.code === 4403) {
        fatal("revoked", "Relay access was revoked.");
        return;
      }
      if (event.code === 4409) {
        fatal("superseded", "This relay connection is active in another tab.");
        return;
      }
      scheduleReconnect();
    });
    next.addEventListener("error", () => {
      /* close owns retry */
    });
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(() => {
      if (generation === currentGeneration && state !== "online") next.close();
    }, HANDSHAKE_TIMEOUT_MS);
  };

  const waitUntilReady = (timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<void> => {
    if (state === "online") return Promise.resolve();
    if (["revoked", "superseded", "error", "closed"].includes(state)) {
      return Promise.reject(new Error(`relay is ${state}`));
    }
    if (state === "idle") connect();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          readyWaiters.delete(waiter);
          reject(new Error("relay did not become ready"));
        }, timeoutMs),
      };
      readyWaiters.add(waiter);
    });
  };

  const relayFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    uploadProgress?: RelayHttpRecord["uploadProgress"],
  ): Promise<Response> => {
    await waitUntilReady();
    if (!cipher || phase !== "ready") throw new TypeError("Relay is unavailable.");
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
      throw new TypeError(`Method ${method} is unavailable over relay.`);
    }
    if (shouldStreamHttp(request)) return streamHttpRequest(request, uploadProgress);
    const rawBody = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
    if (rawBody && rawBody.byteLength > RPC_MAX_BODY_BYTES) {
      throw new TypeError("This request is too large for relay RPC; use a streamed transfer.");
    }
    const id = `rpc-${globalThis.crypto.randomUUID?.() ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
    const payload = {
      id,
      method,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders(request),
      ...(rawBody && rawBody.byteLength > 0 ? { body: encodeBase64Url(rawBody) } : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      if (request.signal.aborted) {
        reject(
          request.signal.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"),
        );
        return;
      }
      const onAbort = () => {
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        clearTimeout(item.timer);
        reject(
          request.signal.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"),
        );
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const item: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.delete(id);
          request.signal.removeEventListener("abort", onAbort);
          reject(new TypeError("Relay request timed out."));
        }, REQUEST_TIMEOUT_MS),
        abort: () => request.signal.removeEventListener("abort", onAbort),
      };
      pending.set(id, item);
      void sendEncrypted("rpc-request", payload).catch(() => {
        if (pending.get(id) !== item) return;
        pending.delete(id);
        clearTimeout(item.timer);
        item.abort?.();
        reject(new TypeError("Relay request could not be sent."));
      });
    });
  };

  return {
    start() {
      if (state === "idle") connect();
    },
    ready: waitUntilReady,
    fetch: relayFetch,
    upload(input, init, onProgress, contentBytes) {
      const controller = new AbortController();
      const upstreamSignal = init.signal;
      let abortTransfer!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortTransfer = (reason) =>
          reject(reason instanceof Error ? reason : new DOMException("Upload cancelled", "AbortError"));
      });
      const onAbort = () => abortTransfer(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const forwardAbort = () => controller.abort(upstreamSignal?.reason);
      if (upstreamSignal?.aborted) forwardAbort();
      else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });

      const reportProgress = (fraction: number) => {
        try {
          onProgress(Math.max(0, Math.min(1, fraction)));
        } catch {
          // Progress observers are presentation-only and must never break an encrypted transfer.
        }
      };
      reportProgress(0);
      const transfer =
        Number.isSafeInteger(contentBytes) && contentBytes >= 0 && contentBytes <= HTTP_STREAM_MAX_REQUEST_BYTES
          ? relayFetch(input, { ...init, signal: controller.signal }, { contentBytes, onProgress: reportProgress })
          : Promise.reject(new TypeError("Invalid relay upload size."));
      const promise = Promise.race([transfer, aborted]).finally(() => {
        controller.signal.removeEventListener("abort", onAbort);
        upstreamSignal?.removeEventListener("abort", forwardAbort);
      });
      return {
        abort() {
          if (!controller.signal.aborted) controller.abort(new DOMException("Upload cancelled", "AbortError"));
        },
        promise,
      };
    },
    openTerminal(terminalOptions) {
      const id = `stream-${globalThis.crypto.randomUUID?.() ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
      const terminal: RelayTerminalRecord = {
        ...terminalOptions,
        id,
        opened: false,
        closed: false,
      };
      safeId(terminal.sessionId, "session id");
      const validDimension = (value: number | undefined) =>
        value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= 1000);
      if (!validDimension(terminal.cols) || !validDimension(terminal.rows))
        throw new Error("invalid terminal dimensions");
      terminals.set(id, terminal);
      if (state === "idle") connect();
      if (state === "online") openTerminalStream(terminal);
      else terminal.onStatus?.("reconnecting");
      const send = (value: unknown) => {
        if (!terminal.opened || terminal.closed || phase !== "ready") return;
        void sendEncrypted("stream-data", { id, data: JSON.stringify(value) }).catch(() => {
          terminal.opened = false;
          terminal.onStatus?.("reconnecting");
        });
      };
      return {
        sendInput: (data) => send({ t: "i", d: data }),
        sendResize: (cols, rows) => send({ t: "r", c: cols, r: rows }),
        requestInputLease: (action, confirm) =>
          send({ t: "lease", action, ...(confirm === undefined ? {} : { confirm }) }),
        reconnect() {
          if (terminal.closed) return;
          if (terminal.opened && phase === "ready") void sendEncrypted("close", { id }).catch(() => undefined);
          terminal.opened = false;
          openTerminalStream(terminal);
        },
        close() {
          if (terminal.closed) return;
          terminal.closed = true;
          terminals.delete(id);
          if (terminal.opened && phase === "ready") void sendEncrypted("close", { id }).catch(() => undefined);
          terminal.opened = false;
        },
      };
    },
    reconnect() {
      if (closed) return;
      generation += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      attempt = 0;
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      socket = undefined;
      cipher?.close();
      cipher = undefined;
      rejectPending("Relay connection was restarted.");
      rejectHttpStreams("Relay file transfer was restarted. Try again to resume it.");
      for (const terminal of terminals.values()) {
        terminal.opened = false;
        terminal.onStatus?.("reconnecting");
      }
      state = "idle";
      connect();
    },
    close() {
      if (closed) return;
      closed = true;
      fatal("closed", "Relay connection was closed.");
      terminals.clear();
    },
    status: () => state,
  };
}
