import type { WebSocket as WebSocketType } from "ws";
import WebSocket from "ws";
import type { DeviceStore } from "./device-store.js";
import {
  createRelayHandshakeHello,
  establishRelayChannel,
  validateRelayIdentity,
  verifyRelayHandshakeHello,
  type RelayCipherState,
  type RelayFrameKind,
  type RelayIdentity,
} from "./relay-crypto.js";
import { parseRelayRpcRequest, relayRpcResponse, type RelayRpcRequest, type RelayRpcResponse } from "./relay-rpc.js";
import { decodeRelayWireEnvelope, encodeRelayWireEnvelope } from "./relay-wire.js";
import { relayCredentialHash } from "./relay-store.js";

const HOST_MESSAGE_MAX_BYTES = 2_000_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const RELAY_STREAM_WINDOW_BYTES = 512 * 1024;
const RELAY_STREAM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_STREAM_REQUEST_BYTES = 64 * 1024 * 1024;

export type RelayHostStatus = "idle" | "connecting" | "online" | "reconnecting" | "stopped";

export interface RelayHostMetrics {
  status: RelayHostStatus;
  activeChannels: number;
  acceptedChannels: number;
  rejectedChannels: number;
  completedRequests: number;
  failedRequests: number;
  reconnects: number;
  activeTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  streamedRequestBytes: number;
  streamedResponseBytes: number;
}

export interface RelayHostConnectorOptions {
  relayUrl: string;
  routeId: string;
  hostCredential: string;
  hostIdentity: RelayIdentity;
  devices: DeviceStore;
  dispatchRequest(token: string, request: RelayRpcRequest): Promise<RelayRpcResponse>;
  openTerminal?: RelayTerminalOpener;
  openHttp?: RelayHttpOpener;
  WebSocketClass?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxStreamRequestBytes?: number;
  onStatus?: (status: RelayHostStatus) => void;
  /** Promotes a five-minute broker bootstrap credential after the E2E pairing claim commits. */
  promoteDevice?: (deviceId: string, credentialHash: string) => Promise<void>;
}

export interface RelayTerminalOpenRequest {
  streamId: string;
  sessionId: string;
  cols?: number;
  rows?: number;
  respawn?: "continue" | "fresh";
}

export interface RelayTerminalHandlers {
  onBinary(data: Uint8Array): void;
  onControl(data: string): void;
  onClose(code: number): void;
}

export interface RelayTerminalBridge {
  send(data: string): void;
  close(): void;
}

export type RelayTerminalOpener = (
  token: string,
  request: RelayTerminalOpenRequest,
  handlers: RelayTerminalHandlers,
) => Promise<RelayTerminalBridge>;

export interface RelayHttpOpenRequest {
  streamId: string;
  method: RelayRpcRequest["method"];
  path: string;
  headers: Record<string, string>;
}

export interface RelayHttpResponseHead {
  status: number;
  headers: Record<string, string>;
}

export interface RelayHttpHandlers {
  onResponse(response: RelayHttpResponseHead): void | Promise<void>;
  onData(data: Uint8Array): void | Promise<void>;
  onEnd(): void | Promise<void>;
  onError(error: Error): void;
}

export interface RelayHttpBridge {
  write(data: Uint8Array): Promise<void>;
  end(): void;
  close(): void;
}

export type RelayHttpOpener = (
  token: string,
  request: RelayHttpOpenRequest,
  handlers: RelayHttpHandlers,
) => Promise<RelayHttpBridge>;

export interface RelayHostConnector {
  start(): void;
  stop(): Promise<void>;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  closeDevice(deviceId: string): void;
  metrics(): RelayHostMetrics;
}

interface TerminalStream {
  kind: "terminal";
  bridge?: RelayTerminalBridge;
  closed: boolean;
}

interface HttpStream {
  kind: "http";
  bridge?: RelayHttpBridge;
  closed: boolean;
  requestCredit: number;
  requestBytes: number;
  responseCredit: number;
  responseBytes: number;
  responseCreditWaiters: Set<() => void>;
  completed: boolean;
}

type HostStream = TerminalStream | HttpStream;

interface HostChannel {
  id: string;
  deviceId: string;
  phase: "handshake" | "auth" | "ready";
  cipher?: RelayCipherState;
  token?: string;
  pairingPublicKey?: string;
  timer?: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  sendQueue: Promise<void>;
  streams: Map<string, HostStream>;
  completedHttpStreams: Set<string>;
  closed: boolean;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid relay ${field}`);
  return value;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function relayConnectUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("relay URL is invalid");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("relay URL cannot contain credentials or query data");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("relay URL must use HTTPS or WSS");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) throw new Error("a non-loopback relay must use TLS");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/connect";
  else if (url.pathname.replace(/\/$/, "") !== "/v1/connect") throw new Error("relay URL path must be /v1/connect");
  return url.href;
}

function rawBuffer(raw: WebSocket.RawData): Buffer {
  const value = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
  if (value.byteLength > HOST_MESSAGE_MAX_BYTES) throw new Error("relay host message is too large");
  return value;
}

function base64UrlBytes(value: unknown, maximum: number): Buffer | undefined {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength > maximum || decoded.toString("base64url") !== value) return undefined;
  return decoded;
}

function parseBrokerMessage(raw: WebSocket.RawData): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawBuffer(raw).toString("utf8"));
  } catch {
    throw new Error("invalid relay broker message");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay broker message");
  return value as Record<string, unknown>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay host request timed out")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid relay ${label}`);
  return value as Record<string, unknown>;
}

function terminalOpenRequest(value: unknown): RelayTerminalOpenRequest {
  const input = objectValue(value, "terminal open request");
  const streamId = safeId(input.id, "stream id");
  const sessionId = safeId(input.sessionId, "session id");
  const dimension = (candidate: unknown) =>
    candidate === undefined ||
    (Number.isSafeInteger(candidate) && (candidate as number) >= 1 && (candidate as number) <= 1000);
  if (!dimension(input.cols) || !dimension(input.rows)) throw new Error("invalid relay terminal dimensions");
  if (input.respawn !== undefined && input.respawn !== "continue" && input.respawn !== "fresh") {
    throw new Error("invalid relay terminal respawn mode");
  }
  return {
    streamId,
    sessionId,
    ...(input.cols === undefined ? {} : { cols: input.cols as number }),
    ...(input.rows === undefined ? {} : { rows: input.rows as number }),
    ...(input.respawn === undefined ? {} : { respawn: input.respawn as "continue" | "fresh" }),
  };
}

function httpOpenRequest(value: unknown): RelayHttpOpenRequest {
  const input = objectValue(value, "HTTP stream open request");
  if (input.type !== "http") throw new Error("invalid relay HTTP stream type");
  const streamId = safeId(input.id, "stream id");
  const request = parseRelayRpcRequest({
    id: streamId,
    method: input.method,
    path: input.path,
    headers: input.headers,
  });
  return {
    streamId,
    method: request.method,
    path: request.path,
    headers: request.headers,
  };
}

export function createRelayHostConnector(options: RelayHostConnectorOptions): RelayHostConnector {
  const url = relayConnectUrl(options.relayUrl);
  const routeId = safeId(options.routeId, "route id");
  if (!/^rrh_[A-Za-z0-9_-]{43}$/.test(options.hostCredential)) throw new Error("invalid relay host credential");
  const identity = validateRelayIdentity(options.hostIdentity);
  const WebSocketClass = options.WebSocketClass ?? WebSocket;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxStreamRequestBytes = options.maxStreamRequestBytes ?? DEFAULT_MAX_STREAM_REQUEST_BYTES;
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1_000 || handshakeTimeoutMs > 30_000) {
    throw new Error("invalid relay host handshake timeout");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw new Error("invalid relay host request timeout");
  }
  if (
    !Number.isSafeInteger(maxStreamRequestBytes) ||
    maxStreamRequestBytes < 1024 * 1024 ||
    maxStreamRequestBytes > 1024 * 1024 * 1024
  ) {
    throw new Error("invalid relay stream request limit");
  }

  let status: RelayHostStatus = "idle";
  let socket: WebSocketType | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let attempt = 0;
  let generation = 0;
  const channels = new Map<string, HostChannel>();
  const readyWaiters = new Set<{ resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const counters = {
    acceptedChannels: 0,
    rejectedChannels: 0,
    completedRequests: 0,
    failedRequests: 0,
    reconnects: 0,
    completedTransfers: 0,
    failedTransfers: 0,
    streamedRequestBytes: 0,
    streamedResponseBytes: 0,
  };

  const setStatus = (next: RelayHostStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
    if (next === "online") {
      for (const waiter of readyWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      readyWaiters.clear();
    }
  };

  const sendBroker = (value: unknown): boolean => {
    if (!socket || socket.readyState !== WebSocketClass.OPEN || socket.bufferedAmount > 4_000_000) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };

  const clearChannel = (channel: HostChannel, notifyBroker: boolean) => {
    if (channel.closed) return;
    channel.closed = true;
    if (channel.timer) clearTimeout(channel.timer);
    for (const stream of channel.streams.values()) {
      stream.closed = true;
      if (stream.kind === "http") {
        for (const wake of stream.responseCreditWaiters) wake();
        stream.responseCreditWaiters.clear();
        if (!stream.completed) {
          stream.completed = true;
          counters.failedTransfers += 1;
        }
      }
      stream.bridge?.close();
    }
    channel.streams.clear();
    channel.cipher?.close();
    channel.token = undefined;
    if (channels.get(channel.id) === channel) channels.delete(channel.id);
    if (notifyBroker) sendBroker({ t: "close-peer", channelId: channel.id });
  };

  const rejectChannel = (channel: HostChannel) => {
    counters.rejectedChannels += 1;
    clearChannel(channel, true);
  };

  const armHandshakeTimeout = (channel: HostChannel) => {
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = setTimeout(() => rejectChannel(channel), handshakeTimeoutMs);
    channel.timer.unref?.();
  };

  const sendEnvelope = (channel: HostChannel, envelope: Parameters<typeof encodeRelayWireEnvelope>[0]): boolean =>
    sendBroker({ t: "frame", channelId: channel.id, payload: encodeRelayWireEnvelope(envelope) });

  const waitForBrokerCapacity = async (channel: HostChannel) => {
    const deadline = Date.now() + requestTimeoutMs;
    while (socket && socket.bufferedAmount > 1024 * 1024) {
      if (channel.closed || Date.now() >= deadline) throw new Error("relay broker remained backpressured");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref?.();
      });
    }
  };

  const sendEncrypted = (channel: HostChannel, kind: RelayFrameKind, value: unknown): Promise<void> => {
    const work = channel.sendQueue.then(async () => {
      if (!channel.cipher || channel.closed) throw new Error("relay channel is unavailable");
      await waitForBrokerCapacity(channel);
      if (!channel.cipher || channel.closed) throw new Error("relay channel is unavailable");
      const frame = channel.cipher.encrypt(kind, Buffer.from(JSON.stringify(value), "utf8"));
      if (!sendEnvelope(channel, { v: 1, t: "cipher", frame })) throw new Error("relay broker is unavailable");
    });
    channel.sendQueue = work.catch(() => undefined);
    return work;
  };

  const finishHttpStream = (channel: HostChannel, streamId: string, stream: HttpStream, success: boolean) => {
    if (stream.completed) return;
    stream.completed = true;
    stream.closed = true;
    for (const wake of stream.responseCreditWaiters) wake();
    stream.responseCreditWaiters.clear();
    stream.bridge?.close();
    if (channel.streams.get(streamId) === stream) channel.streams.delete(streamId);
    channel.completedHttpStreams.add(streamId);
    if (channel.completedHttpStreams.size > 256) {
      channel.completedHttpStreams.delete(channel.completedHttpStreams.values().next().value!);
    }
    if (success) counters.completedTransfers += 1;
    else counters.failedTransfers += 1;
  };

  const waitForResponseCredit = async (stream: HttpStream) => {
    while (!stream.closed && stream.responseCredit <= 0) {
      let wake!: () => void;
      const available = new Promise<void>((resolve) => {
        wake = resolve;
        stream.responseCreditWaiters.add(resolve);
      });
      try {
        await withTimeout(available, Math.max(60_000, requestTimeoutMs));
      } finally {
        stream.responseCreditWaiters.delete(wake);
      }
    }
    if (stream.closed) throw new Error("relay HTTP response stream closed");
  };

  const sendHttpResponseData = async (channel: HostChannel, streamId: string, stream: HttpStream, data: Uint8Array) => {
    for (let offset = 0; offset < data.byteLength;) {
      await waitForResponseCredit(stream);
      const size = Math.min(RELAY_STREAM_CHUNK_BYTES, stream.responseCredit, data.byteLength - offset);
      const chunk = Buffer.from(data.subarray(offset, offset + size));
      stream.responseCredit -= size;
      stream.responseBytes += size;
      counters.streamedResponseBytes += size;
      await sendEncrypted(channel, "stream-data", { id: streamId, data: chunk.toString("base64url") });
      offset += size;
    }
  };

  const handleHandshake = async (channel: HostChannel, payload: unknown) => {
    const envelope = decodeRelayWireEnvelope(payload);
    if (envelope.t !== "device-hello") throw new Error("device handshake required");
    const pinned = options.devices.relayIdentity(channel.deviceId);
    const identityPublicKey = pinned?.publicKey ?? envelope.identityPublicKey;
    if (!identityPublicKey || (!pinned && !options.devices.pendingRelayPairing(channel.deviceId, now()))) {
      throw new Error("relay device identity is not paired");
    }
    if (pinned && envelope.identityPublicKey && envelope.identityPublicKey !== pinned.publicKey) {
      throw new Error("relay device identity changed");
    }
    verifyRelayHandshakeHello(envelope.hello, {
      role: "device",
      routeId,
      deviceId: channel.deviceId,
      sessionId: envelope.hello.sessionId,
      identityPublicKey,
      now: now(),
    });
    const host = createRelayHandshakeHello({
      role: "host",
      routeId,
      deviceId: channel.deviceId,
      sessionId: envelope.hello.sessionId,
      identity,
      issuedAt: now(),
    });
    channel.cipher = establishRelayChannel({
      role: "host",
      localEphemeral: host.ephemeral,
      deviceHello: envelope.hello,
      hostHello: host.hello,
      deviceIdentityPublicKey: identityPublicKey,
      hostIdentityPublicKey: identity.publicKey,
      now,
    });
    if (!pinned) channel.pairingPublicKey = identityPublicKey;
    channel.phase = "auth";
    armHandshakeTimeout(channel);
    if (!sendEnvelope(channel, { v: 1, t: "host-hello", hello: host.hello })) {
      throw new Error("relay broker is unavailable");
    }
  };

  const handleAuth = async (channel: HostChannel, payload: unknown) => {
    const envelope = decodeRelayWireEnvelope(payload);
    if (envelope.t !== "cipher" || envelope.frame.kind !== "auth" || !channel.cipher) {
      throw new Error("encrypted relay authentication required");
    }
    const decoded = channel.cipher.decrypt(envelope.frame);
    let auth: unknown;
    try {
      auth = JSON.parse(decoded.toString("utf8"));
    } finally {
      decoded.fill(0);
    }
    const record = auth && typeof auth === "object" && !Array.isArray(auth) ? (auth as Record<string, unknown>) : {};
    const token = typeof record.token === "string" ? record.token : undefined;
    const pairing =
      record.pairing && typeof record.pairing === "object" && !Array.isArray(record.pairing)
        ? (record.pairing as Record<string, unknown>)
        : undefined;
    let device = token ? options.devices.authenticate(token, now(), "relay") : undefined;
    if (!device && token && channel.pairingPublicKey && pairing) {
      const secret = typeof pairing.secret === "string" ? pairing.secret : "";
      const name = typeof pairing.name === "string" ? pairing.name : "";
      device = options.devices.claimRelayPairing(secret, token, name, channel.pairingPublicKey, now())?.device;
    }
    if (!token || !device || device.id !== channel.deviceId) throw new Error("relay device credential is invalid");
    if (pairing) {
      const routingCredential = typeof record.relayCredential === "string" ? record.relayCredential : "";
      if (!/^rrd_[A-Za-z0-9_-]{43}$/.test(routingCredential) || !options.promoteDevice) {
        throw new Error("relay routing credential cannot be promoted");
      }
      await options.promoteDevice(device.id, relayCredentialHash(routingCredential));
    }
    channel.token = token;
    channel.pairingPublicKey = undefined;
    channel.phase = "ready";
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = undefined;
    counters.acceptedChannels += 1;
    await sendEncrypted(channel, "auth", {
      ok: true,
      deviceId: channel.deviceId,
      hostIdentityFingerprint: identity.fingerprint,
    });
  };

  const handleReady = async (channel: HostChannel, payload: unknown) => {
    const envelope = decodeRelayWireEnvelope(payload);
    if (envelope.t !== "cipher" || !channel.cipher || !channel.token) {
      throw new Error("encrypted relay request required");
    }
    const decoded = channel.cipher.decrypt(envelope.frame);
    let value: unknown;
    try {
      value = JSON.parse(decoded.toString("utf8"));
    } finally {
      decoded.fill(0);
    }
    if (envelope.frame.kind === "rpc-request") {
      const request = parseRelayRpcRequest(value);
      let response: RelayRpcResponse;
      try {
        response = await withTimeout(options.dispatchRequest(channel.token, request), requestTimeoutMs);
        counters.completedRequests += 1;
      } catch {
        counters.failedRequests += 1;
        response = relayRpcResponse({
          id: request.id,
          status: 502,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ code: "RELAY_HOST_ERROR", error: "host request failed" })),
        });
      }
      await sendEncrypted(channel, "rpc-response", response);
      return;
    }
    if (envelope.frame.kind === "stream-open") {
      const input = objectValue(value, "stream open request");
      if (input.type === "http") {
        const request = httpOpenRequest(input);
        if (channel.streams.has(request.streamId)) throw new Error("relay stream already exists");
        if (!options.openHttp) {
          await sendEncrypted(channel, "stream-open", {
            id: request.streamId,
            type: "http",
            ok: false,
            error: "HTTP streaming unavailable",
          });
          return;
        }
        const stream: HttpStream = {
          kind: "http",
          closed: false,
          requestCredit: RELAY_STREAM_WINDOW_BYTES,
          requestBytes: 0,
          responseCredit: 0,
          responseBytes: 0,
          responseCreditWaiters: new Set(),
          completed: false,
        };
        channel.streams.set(request.streamId, stream);
        try {
          const bridge = await withTimeout(
            options.openHttp(channel.token, request, {
              async onResponse(response) {
                if (stream.closed || channel.closed) return;
                const head = relayRpcResponse({
                  id: request.streamId,
                  status: response.status,
                  headers: response.headers,
                });
                await sendEncrypted(channel, "stream-open", {
                  id: request.streamId,
                  type: "http",
                  ok: true,
                  status: head.status,
                  headers: head.headers,
                });
              },
              async onData(data) {
                if (stream.closed || channel.closed) throw new Error("relay HTTP response stream closed");
                await sendHttpResponseData(channel, request.streamId, stream, data);
              },
              async onEnd() {
                if (stream.closed || channel.closed) return;
                await sendEncrypted(channel, "stream-control", {
                  id: request.streamId,
                  event: "response-end",
                  bytes: stream.responseBytes,
                });
                finishHttpStream(channel, request.streamId, stream, true);
              },
              onError() {
                if (stream.closed || channel.closed) return;
                void sendEncrypted(channel, "close", {
                  id: request.streamId,
                  code: 1011,
                  error: "host request failed",
                }).finally(() => finishHttpStream(channel, request.streamId, stream, false));
              },
            }),
            requestTimeoutMs,
          );
          if (stream.closed || channel.closed) {
            bridge.close();
            return;
          }
          stream.bridge = bridge;
          await sendEncrypted(channel, "stream-control", {
            id: request.streamId,
            event: "request-credit",
            bytes: stream.requestCredit,
          });
        } catch {
          finishHttpStream(channel, request.streamId, stream, false);
          await sendEncrypted(channel, "stream-open", {
            id: request.streamId,
            type: "http",
            ok: false,
            error: "HTTP streaming unavailable",
          });
        }
        return;
      }
      const request = terminalOpenRequest(value);
      if (channel.streams.has(request.streamId)) throw new Error("relay stream already exists");
      if (!options.openTerminal) {
        await sendEncrypted(channel, "stream-open", { id: request.streamId, ok: false, error: "terminal unavailable" });
        return;
      }
      const stream: TerminalStream = { kind: "terminal", closed: false };
      channel.streams.set(request.streamId, stream);
      try {
        const bridge = await withTimeout(
          options.openTerminal(channel.token, request, {
            onBinary(data) {
              if (stream.closed || channel.closed) return;
              for (let offset = 0; offset < data.byteLength; offset += 64 * 1024) {
                const chunk = Buffer.from(data.subarray(offset, Math.min(data.byteLength, offset + 64 * 1024)));
                void sendEncrypted(channel, "stream-data", {
                  id: request.streamId,
                  data: chunk.toString("base64url"),
                }).catch(() => {
                  stream.closed = true;
                  stream.bridge?.close();
                  channel.streams.delete(request.streamId);
                });
              }
            },
            onControl(data) {
              if (stream.closed || channel.closed || Buffer.byteLength(data) > 256 * 1024) return;
              void sendEncrypted(channel, "stream-control", { id: request.streamId, data }).catch(() => {
                stream.closed = true;
                stream.bridge?.close();
                channel.streams.delete(request.streamId);
              });
            },
            onClose(code) {
              if (stream.closed) return;
              stream.closed = true;
              channel.streams.delete(request.streamId);
              if (!channel.closed)
                void sendEncrypted(channel, "close", { id: request.streamId, code }).catch(() => undefined);
            },
          }),
          requestTimeoutMs,
        );
        if (stream.closed || channel.closed) {
          bridge.close();
          return;
        }
        stream.bridge = bridge;
        await sendEncrypted(channel, "stream-open", { id: request.streamId, ok: true });
      } catch {
        stream.closed = true;
        stream.bridge?.close();
        channel.streams.delete(request.streamId);
        await sendEncrypted(channel, "stream-open", { id: request.streamId, ok: false, error: "terminal unavailable" });
      }
      return;
    }
    if (envelope.frame.kind === "stream-data") {
      const input = objectValue(value, "stream input");
      const streamId = safeId(input.id, "stream id");
      const stream = channel.streams.get(streamId);
      if (!stream && channel.completedHttpStreams.has(streamId)) return;
      if (stream?.kind === "http") {
        const data = base64UrlBytes(input.data, RELAY_STREAM_CHUNK_BYTES);
        if (!stream.bridge || stream.closed || !data || data.byteLength > stream.requestCredit) {
          throw new Error("relay HTTP upload exceeded its credit window");
        }
        const nextBytes = stream.requestBytes + data.byteLength;
        if (nextBytes > maxStreamRequestBytes) {
          // Close and tombstone the stream before queueing the encrypted error. Subsequent already-buffered chunks
          // are then ignored instead of racing the asynchronous send and reaching the loopback request.
          finishHttpStream(channel, streamId, stream, false);
          void sendEncrypted(channel, "close", {
            id: streamId,
            code: 1009,
            error: "request body is too large",
          }).catch(() => undefined);
          return;
        }
        stream.requestCredit -= data.byteLength;
        stream.requestBytes = nextBytes;
        counters.streamedRequestBytes += data.byteLength;
        await stream.bridge.write(data);
        if (!stream.closed && !channel.closed) {
          stream.requestCredit += data.byteLength;
          await sendEncrypted(channel, "stream-control", {
            id: streamId,
            event: "request-credit",
            bytes: data.byteLength,
          });
        }
        return;
      }
      if (
        stream?.kind !== "terminal" ||
        !stream.bridge ||
        stream.closed ||
        typeof input.data !== "string" ||
        Buffer.byteLength(input.data) > 1024 * 1024
      ) {
        throw new Error("relay terminal stream is unavailable");
      }
      stream.bridge.send(input.data);
      return;
    }
    if (envelope.frame.kind === "stream-control") {
      const input = objectValue(value, "stream control");
      const streamId = safeId(input.id, "stream id");
      const stream = channel.streams.get(streamId);
      if (!stream && channel.completedHttpStreams.has(streamId)) return;
      if (stream?.kind !== "http" || stream.closed) throw new Error("relay HTTP stream is unavailable");
      if (input.event === "request-end") {
        if (input.bytes !== stream.requestBytes) throw new Error("relay HTTP request length mismatch");
        stream.bridge?.end();
        return;
      }
      if (input.event === "response-credit") {
        const bytes = input.bytes;
        if (
          !Number.isSafeInteger(bytes) ||
          (bytes as number) < 1 ||
          (bytes as number) > RELAY_STREAM_WINDOW_BYTES ||
          stream.responseCredit + (bytes as number) > RELAY_STREAM_WINDOW_BYTES
        ) {
          throw new Error("invalid relay HTTP response credit");
        }
        stream.responseCredit += bytes as number;
        for (const wake of stream.responseCreditWaiters) wake();
        stream.responseCreditWaiters.clear();
        return;
      }
      throw new Error("invalid relay HTTP stream control");
    }
    if (envelope.frame.kind === "close") {
      const input = objectValue(value, "terminal close");
      const id = safeId(input.id, "stream id");
      const stream = channel.streams.get(id);
      if (stream) {
        if (stream.kind === "http") finishHttpStream(channel, id, stream, false);
        else {
          stream.closed = true;
          stream.bridge?.close();
          channel.streams.delete(id);
        }
      }
      return;
    }
    throw new Error("unexpected encrypted relay frame");
  };

  const queueFrame = (channel: HostChannel, payload: unknown) => {
    channel.queue = channel.queue
      .then(async () => {
        if (channel.closed) return;
        if (channel.phase === "handshake") await handleHandshake(channel, payload);
        else if (channel.phase === "auth") await handleAuth(channel, payload);
        else await handleReady(channel, payload);
      })
      .catch(() => rejectChannel(channel));
  };

  const clearAllChannels = () => {
    for (const channel of [...channels.values()]) clearChannel(channel, false);
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    clearAllChannels();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
    setStatus("reconnecting");
    counters.reconnects += 1;
    const delay = Math.min(15_000, 500 * 2 ** attempt) + Math.floor(random() * 250);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  };

  const connect = () => {
    if (stopped) return;
    const currentGeneration = ++generation;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    let next: WebSocketType;
    try {
      next = new WebSocketClass(url) as WebSocketType;
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;
    next.on("open", () => {
      if (generation !== currentGeneration || stopped) return;
      sendBroker({ v: 1, role: "host", routeId, credential: options.hostCredential });
    });
    next.on("message", (raw, isBinary) => {
      if (generation !== currentGeneration || stopped || isBinary) {
        if (isBinary) next.close(4400, "text broker messages required");
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = parseBrokerMessage(raw);
      } catch {
        next.close(4400, "invalid broker message");
        return;
      }
      if (message.t === "ready" && message.role === "host") {
        attempt = 0;
        setStatus("online");
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => sendBroker({ t: "ping" }), PING_INTERVAL_MS);
        pingTimer.unref?.();
        return;
      }
      if (message.t === "peer-open") {
        let channelId: string;
        let deviceId: string;
        try {
          channelId = safeId(message.channelId, "channel id");
          deviceId = safeId(message.deviceId, "device id");
        } catch {
          next.close(4400, "invalid peer routing data");
          return;
        }
        const previous = channels.get(channelId);
        if (previous) clearChannel(previous, true);
        const channel: HostChannel = {
          id: channelId,
          deviceId,
          phase: "handshake",
          queue: Promise.resolve(),
          sendQueue: Promise.resolve(),
          streams: new Map(),
          completedHttpStreams: new Set(),
          closed: false,
        };
        channels.set(channelId, channel);
        armHandshakeTimeout(channel);
        return;
      }
      if (message.t === "peer-close") {
        const channel = typeof message.channelId === "string" ? channels.get(message.channelId) : undefined;
        if (channel) clearChannel(channel, false);
        return;
      }
      if (message.t === "frame") {
        const channel = typeof message.channelId === "string" ? channels.get(message.channelId) : undefined;
        if (!channel) return;
        queueFrame(channel, message.payload);
      }
    });
    next.once("close", () => {
      if (generation !== currentGeneration) return;
      socket = undefined;
      if (!stopped) scheduleReconnect();
    });
    next.once("error", () => {
      /* close owns reconnect */
    });
  };

  return {
    start() {
      if (stopped || status !== "idle") return;
      connect();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      reconnectTimer = undefined;
      pingTimer = undefined;
      clearAllChannels();
      const current = socket;
      socket = undefined;
      if (current && current.readyState < WebSocketClass.CLOSING) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref?.();
          current.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          current.close(1000, "host stopping");
        });
      }
      for (const waiter of readyWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("relay host stopped"));
      }
      readyWaiters.clear();
      setStatus("stopped");
    },
    waitUntilReady(timeoutMs = 10_000) {
      if (status === "online") return Promise.resolve();
      if (stopped) return Promise.reject(new Error("relay host stopped"));
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            readyWaiters.delete(waiter);
            reject(new Error("relay host did not become ready"));
          }, timeoutMs),
        };
        waiter.timer.unref?.();
        readyWaiters.add(waiter);
      });
    },
    closeDevice(deviceId) {
      for (const channel of [...channels.values()]) if (channel.deviceId === deviceId) clearChannel(channel, true);
    },
    metrics: () => ({
      status,
      activeChannels: channels.size,
      activeTransfers: [...channels.values()].reduce(
        (count, channel) =>
          count + [...channel.streams.values()].filter((stream) => stream.kind === "http" && !stream.closed).length,
        0,
      ),
      ...counters,
    }),
  };
}
