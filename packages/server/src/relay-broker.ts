import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type WebSocket from "ws";
import {
  generateRelayAccountCredential,
  RelayAccountRevisionConflictError,
  type CreateRelayAccountInput,
  type RelayAccountCredentialMaterial,
  type RelayAccountPlan,
  type RelayAccountCredentialInput,
  type RelayAccountRecord,
  type RelayAccountStore,
  type UpdateRelayAccountInput,
} from "./relay-account-store.js";
import {
  generateRelayCredential,
  openRelayRouteStore,
  relayCredentialHash,
  type PublicRelayRouteRecord,
  type RelayRouteStore,
} from "./relay-store.js";

export const BLIND_RELAY_PROTOCOL_VERSION = 1 as const;
export const BLIND_RELAY_DEFAULT_MAX_FRAME_BYTES = 1_500_000;
export const BLIND_RELAY_DEFAULT_MAX_QUEUE_BYTES = 4_000_000;
export const BLIND_RELAY_DEFAULT_MAX_TOTAL_CONNECTIONS = 1_024;
export const BLIND_RELAY_DEFAULT_MAX_CONNECTIONS_PER_ROUTE = 64;
export const BLIND_RELAY_DEFAULT_MAX_BYTES_PER_MINUTE = 64 * 1024 * 1024;
export const BLIND_RELAY_DEFAULT_MAX_MESSAGES_PER_MINUTE = 12_000;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface CreateBlindRelayOptions {
  rootToken: string;
  /** Previous provisioning capabilities accepted only during an explicit, bounded zero-downtime rotation window. */
  previousRootTokens?: string[];
  store?: RelayRouteStore;
  /** Optional hosted control plane. Self-hosted root-only routing remains available without it. */
  accountStore?: RelayAccountStore;
  allowedOrigins?: string[];
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxFrameBytes?: number;
  maxQueueBytes?: number;
  maxTotalConnections?: number;
  maxConnectionsPerRoute?: number;
  maxBytesPerMinute?: number;
  maxMessagesPerMinute?: number;
  now?: () => number;
  generateChannelId?: () => string;
}

export interface BlindRelayMetrics {
  activeConnections: number;
  activeHosts: number;
  activeDevices: number;
  acceptedConnections: number;
  rejectedConnections: number;
  forwardedFrames: number;
  forwardedBytes: number;
  droppedFrames: number;
}

export interface BlindRelayServer {
  app: FastifyInstance;
  store: RelayRouteStore;
  accountStore?: RelayAccountStore;
  metrics(): BlindRelayMetrics;
}

type RelayAuthHello =
  | { v: 1; role: "host"; routeId: string; credential: string }
  | { v: 1; role: "device"; routeId: string; deviceId: string; credential: string };

interface RateWindow {
  startedAt: number;
  lastSeenAt: number;
  bytes: number;
  messages: number;
}

interface LiveDevice {
  socket: WebSocket;
  routeId: string;
  deviceId: string;
  channelId: string;
  rate: RateWindow;
  closed: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

interface LiveHost {
  socket: WebSocket;
  routeId: string;
  ownerAccountId?: string;
  devices: Map<string, LiveDevice>;
  rate: RateWindow;
  closed: boolean;
  idle?: ReturnType<typeof setTimeout>;
}

function safeToken(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`invalid relay ${field}`);
  }
  return value;
}

function safeCredentialHash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid relay credential hash");
  }
  return value;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid relay ${field}`);
  return value;
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("relay route label is required");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 80 || UNSAFE_DISPLAY_TEXT.test(label)) throw new Error("invalid relay route label");
  return label;
}

function safeExpiry(value: unknown, now: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= now || (value as number) > now + 10 * 60_000) {
    throw new Error("invalid relay device expiry");
  }
  return value as number;
}

function safeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("invalid relay account revision");
  return value as number;
}

function safeAccountId(value: unknown): string {
  if (typeof value !== "string" || !/^rra_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("invalid relay account id");
  }
  return value;
}

function safeAccountLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("relay account label is required");
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 120 || UNSAFE_DISPLAY_TEXT.test(label)) throw new Error("invalid relay account label");
  return label;
}

function safeAccountPlan(value: unknown): RelayAccountPlan {
  if (value !== "free" && value !== "team" && value !== "enterprise") {
    throw new Error("invalid relay account plan");
  }
  return value;
}

function safeAccountLimit(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error("invalid relay account limit");
  }
  return value as number;
}

function strictInternalBody(value: unknown, allowedFields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid internal request body");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((field) => !allowedFields.includes(field))) {
    throw new Error("unknown internal request field");
  }
  return body;
}

function safeCredentialLookup(value: unknown): string {
  if (typeof value !== "string" || !/^lookup:[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid relay credential lookup");
  }
  return value;
}

function safeAccountCredentialMaterial(body: Record<string, unknown> | undefined): RelayAccountCredentialMaterial {
  if (!body || body.credential !== undefined || body.accountCredential !== undefined) {
    throw new Error("client-hashed account credential material is required");
  }
  return {
    credentialHash: safeCredentialHash(body.credentialHash),
    credentialLookup: safeCredentialLookup(body.credentialLookup),
  };
}

function safeRouteCredentialHash(body: Record<string, unknown> | undefined, field = "credentialHash"): string {
  if (!body || body.credential !== undefined || body.hostCredential !== undefined) {
    throw new Error("client-hashed route credential material is required");
  }
  return safeCredentialHash(body[field]);
}

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  if (!value || Array.isArray(value)) return;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value);
  return match?.[1];
}

function tokenMatches(left: string, right: string | undefined): boolean {
  if (!right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicRoute(route: PublicRelayRouteRecord): PublicRelayRouteRecord {
  return {
    id: route.id,
    label: route.label,
    deviceCount: route.deviceCount,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

function parseJson(raw: WebSocket.RawData, limit: number): unknown {
  const buffer = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
  if (buffer.byteLength > limit) throw new Error("relay frame too large");
  return JSON.parse(buffer.toString("utf8")) as unknown;
}

function parseAuthHello(value: unknown): RelayAuthHello {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay hello");
  const hello = value as Record<string, unknown>;
  if (hello.v !== BLIND_RELAY_PROTOCOL_VERSION || (hello.role !== "host" && hello.role !== "device")) {
    throw new Error("invalid relay hello");
  }
  const routeId = safeId(hello.routeId, "route id");
  const credential = safeToken(hello.credential, "credential");
  return hello.role === "host"
    ? { v: 1, role: "host", routeId, credential }
    : { v: 1, role: "device", routeId, deviceId: safeId(hello.deviceId, "device id"), credential };
}

function parsePayload(
  value: unknown,
  requireChannel: boolean,
  maxBytes: number,
): { channelId?: string; payload: string; bytes: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay frame");
  const frame = value as Record<string, unknown>;
  if (frame.t !== "frame" || typeof frame.payload !== "string" || !/^[A-Za-z0-9_-]+$/.test(frame.payload)) {
    throw new Error("invalid relay frame");
  }
  const bytes = Math.floor((frame.payload.length * 3) / 4);
  if (bytes < 1 || bytes > maxBytes) throw new Error("relay frame too large");
  const canonical = Buffer.from(frame.payload, "base64url").toString("base64url");
  if (canonical !== frame.payload) throw new Error("invalid relay frame");
  return {
    ...(requireChannel ? { channelId: safeId(frame.channelId, "channel id") } : {}),
    payload: frame.payload,
    bytes,
  };
}

function safeSend(socket: WebSocket, value: unknown, maxQueueBytes: number): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  const encoded = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(encoded) > maxQueueBytes) return false;
  try {
    socket.send(encoded);
    return true;
  } catch {
    return false;
  }
}

export function createBlindRelayServer(options: CreateBlindRelayOptions): BlindRelayServer {
  const rootTokens = [safeToken(options.rootToken, "root token")];
  for (const token of options.previousRootTokens ?? []) rootTokens.push(safeToken(token, "previous root token"));
  if (rootTokens.length > 4 || new Set(rootTokens).size !== rootTokens.length) {
    throw new Error("invalid relay root token rotation set");
  }
  const store = options.store ?? openRelayRouteStore({ dbPath: ":memory:" });
  const ownsStore = options.store === undefined;
  const accountStore = options.accountStore;
  const now = options.now ?? Date.now;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 2 * 60_000;
  const maxFrameBytes = options.maxFrameBytes ?? BLIND_RELAY_DEFAULT_MAX_FRAME_BYTES;
  const maxQueueBytes = options.maxQueueBytes ?? BLIND_RELAY_DEFAULT_MAX_QUEUE_BYTES;
  const maxTotalConnections = options.maxTotalConnections ?? BLIND_RELAY_DEFAULT_MAX_TOTAL_CONNECTIONS;
  const maxConnectionsPerRoute = options.maxConnectionsPerRoute ?? BLIND_RELAY_DEFAULT_MAX_CONNECTIONS_PER_ROUTE;
  const maxBytesPerMinute = options.maxBytesPerMinute ?? BLIND_RELAY_DEFAULT_MAX_BYTES_PER_MINUTE;
  const maxMessagesPerMinute = options.maxMessagesPerMinute ?? BLIND_RELAY_DEFAULT_MAX_MESSAGES_PER_MINUTE;
  for (const [value, minimum, maximum, label] of [
    [handshakeTimeoutMs, 1_000, 30_000, "handshake timeout"],
    [idleTimeoutMs, 10_000, 60 * 60_000, "idle timeout"],
    [maxFrameBytes, 1_024, 16 * 1024 * 1024, "frame limit"],
    [maxQueueBytes, 1_024, 64 * 1024 * 1024, "queue limit"],
    [maxTotalConnections, 1, 100_000, "total connection limit"],
    [maxConnectionsPerRoute, 1, 10_000, "connection limit"],
    [maxBytesPerMinute, 1_024, 1024 * 1024 * 1024, "byte rate"],
    [maxMessagesPerMinute, 10, 1_000_000, "message rate"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid relay ${label}`);
  }
  const maxEnvelopeBytes = Math.max(8 * 1024, Math.ceil((maxFrameBytes * 4) / 3) + 8 * 1024);
  const configuredOrigins = options.allowedOrigins ?? [];
  const normalizedOrigins = configuredOrigins.map(normalizeOrigin);
  if (normalizedOrigins.some((origin) => origin === undefined)) {
    throw new Error("invalid relay allowed origin");
  }
  const allowedOrigins = new Set(normalizedOrigins as string[]);
  const generateChannelId = options.generateChannelId ?? (() => `rrc_${randomBytes(16).toString("base64url")}`);
  const hosts = new Map<string, LiveHost>();
  const devicesByChannel = new Map<string, LiveDevice>();
  const sockets = new Set<WebSocket>();
  const hostRates = new Map<string, RateWindow>();
  const deviceRates = new Map<string, RateWindow>();
  const maxRateIdentities = Math.min(100_000, Math.max(256, maxTotalConnections * 4));
  const deviceRateKey = (routeId: string, deviceId: string) => `${routeId}\0${deviceId}`;
  const clearRouteRates = (routeId: string) => {
    hostRates.delete(routeId);
    for (const key of deviceRates.keys()) if (key.startsWith(`${routeId}\0`)) deviceRates.delete(key);
  };
  const rateWindowFor = (windows: Map<string, RateWindow>, key: string): RateWindow | undefined => {
    const current = now();
    if (windows.size >= maxRateIdentities) {
      for (const [candidate, window] of windows) {
        if (current - window.lastSeenAt >= 120_000) windows.delete(candidate);
      }
    }
    const existing = windows.get(key);
    if (existing) {
      existing.lastSeenAt = current;
      return existing;
    }
    if (windows.size >= maxRateIdentities) return;
    const created = { startedAt: current, lastSeenAt: current, bytes: 0, messages: 0 };
    windows.set(key, created);
    return created;
  };
  const consumeRate = (window: RateWindow, bytes: number): boolean => {
    const current = now();
    if (current - window.startedAt >= 60_000) {
      window.startedAt = current;
      window.bytes = 0;
      window.messages = 0;
    }
    window.lastSeenAt = current;
    window.bytes += bytes;
    window.messages += 1;
    return window.bytes <= maxBytesPerMinute && window.messages <= maxMessagesPerMinute;
  };
  const metrics: BlindRelayMetrics = {
    activeConnections: 0,
    activeHosts: 0,
    activeDevices: 0,
    acceptedConnections: 0,
    rejectedConnections: 0,
    forwardedFrames: 0,
    forwardedBytes: 0,
    droppedFrames: 0,
  };
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 32 * 1024 });
  const authenticatedAccounts = new WeakMap<FastifyRequest, RelayAccountRecord>();

  const routeAccountIsActive = (routeId: string): boolean => {
    const ownerAccountId = store.getRoute(routeId)?.ownerAccountId;
    if (!ownerAccountId) return true;
    return accountStore?.getAccount(ownerAccountId)?.status === "active";
  };

  const requireRoot = async (request: FastifyRequest, reply: FastifyReply) => {
    const presented = bearer(request);
    if (rootTokens.some((token) => tokenMatches(token, presented))) return;
    reply.header("www-authenticate", "Bearer").code(401).send({ code: "RELAY_UNAUTHORIZED", error: "unauthorized" });
  };
  const requireHost = async (request: FastifyRequest<{ Params: { routeId: string } }>, reply: FastifyReply) => {
    try {
      if (
        routeAccountIsActive(request.params.routeId) &&
        store.authenticateHost(request.params.routeId, bearer(request) ?? "")
      )
        return;
    } catch {
      /* same non-enumerating denial */
    }
    reply.header("www-authenticate", "Bearer").code(401).send({ code: "RELAY_UNAUTHORIZED", error: "unauthorized" });
  };
  const requireAccount = async (request: FastifyRequest, reply: FastifyReply) => {
    const account = accountStore?.authenticate(bearer(request) ?? "");
    if (account) {
      authenticatedAccounts.set(request, account);
      return;
    }
    reply.header("www-authenticate", "Bearer").code(401).send({ code: "RELAY_UNAUTHORIZED", error: "unauthorized" });
  };
  const requireRecoverableAccount = async (request: FastifyRequest, reply: FastifyReply) => {
    const account = accountStore?.verifyCredential(bearer(request) ?? "");
    if (account) {
      authenticatedAccounts.set(request, account);
      return;
    }
    reply.header("www-authenticate", "Bearer").code(401).send({ code: "RELAY_UNAUTHORIZED", error: "unauthorized" });
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'none'");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.get("/health", async () => ({ status: "ok", protocolVersion: BLIND_RELAY_PROTOCOL_VERSION }));
  app.get("/ready", async (_request, reply) => {
    try {
      store.listRoutes(now());
      accountStore?.listAccounts();
      return { status: "ready", protocolVersion: BLIND_RELAY_PROTOCOL_VERSION };
    } catch {
      reply.code(503);
      return { status: "unavailable", protocolVersion: BLIND_RELAY_PROTOCOL_VERSION };
    }
  });
  app.get("/v1/metrics", { preHandler: requireRoot }, async () => ({
    protocolVersion: BLIND_RELAY_PROTOCOL_VERSION,
    metrics: {
      ...metrics,
      activeConnections: sockets.size,
      activeHosts: hosts.size,
      activeDevices: devicesByChannel.size,
    },
  }));
  app.get("/v1/routes", { preHandler: requireRoot }, async () => ({ routes: store.listRoutes().map(publicRoute) }));
  app.post<{ Body: { id?: unknown; label?: unknown } }>(
    "/v1/routes",
    { preHandler: requireRoot },
    async (request, reply) => {
      try {
        const hostCredential = generateRelayCredential("rrh");
        const route = store.createRoute({
          ...(request.body?.id === undefined ? {} : { id: safeId(request.body.id, "route id") }),
          label: safeLabel(request.body?.label),
          hostCredentialHash: relayCredentialHash(hostCredential),
        });
        reply.code(201).send({
          route: {
            id: route.id,
            label: route.label,
            deviceCount: 0,
            createdAt: route.createdAt,
            updatedAt: route.updatedAt,
          },
          hostCredential,
        });
      } catch (error) {
        const conflict = (error as Error).message === "relay route already exists";
        reply.code(conflict ? 409 : 400).send({
          code: conflict ? "RELAY_ROUTE_EXISTS" : "INVALID_RELAY_ROUTE",
          error: conflict ? "relay route already exists" : "invalid relay route",
        });
      }
    },
  );
  app.delete<{ Params: { routeId: string } }>(
    "/v1/routes/:routeId",
    { preHandler: requireRoot },
    async (request, reply) => {
      let removed = false;
      try {
        removed = store.deleteRoute(request.params.routeId);
      } catch {
        /* invalid and unknown are the same public result */
      }
      if (!removed) {
        reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
        return;
      }
      clearRouteRates(request.params.routeId);
      const host = hosts.get(request.params.routeId);
      host?.socket.close(4403, "route deleted");
      for (const device of host?.devices.values() ?? []) device.socket.close(4403, "route deleted");
      reply.code(204).send();
    },
  );
  app.get<{ Params: { routeId: string } }>(
    "/v1/routes/:routeId/status",
    { preHandler: requireHost },
    async (request) => ({
      routeId: request.params.routeId,
      hostOnline: hosts.has(request.params.routeId),
      activeDevices: hosts.get(request.params.routeId)?.devices.size ?? 0,
    }),
  );
  app.put<{
    Params: { routeId: string; deviceId: string };
    Body: { credentialHash?: unknown; expiresAt?: unknown };
  }>("/v1/routes/:routeId/devices/:deviceId", { preHandler: requireHost }, async (request, reply) => {
    try {
      const route = store.getRoute(request.params.routeId);
      if (route?.ownerAccountId && !store.getDevice(route.id, request.params.deviceId, now())) {
        const account = accountStore?.getAccount(route.ownerAccountId);
        if (!account || store.countDevices(route.id, now()) >= account.maxDevicesPerRoute) {
          reply.code(429).send({ code: "RELAY_DEVICE_LIMIT", error: "relay device limit reached" });
          return;
        }
      }
      const device = store.putDevice({
        routeId: request.params.routeId,
        deviceId: request.params.deviceId,
        credentialHash: typeof request.body?.credentialHash === "string" ? request.body.credentialHash : "invalid",
        ...(request.body?.expiresAt === undefined ? {} : { expiresAt: safeExpiry(request.body.expiresAt, now()) }),
      });
      reply.code(200).send({
        device: {
          routeId: device.routeId,
          deviceId: device.deviceId,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
        },
      });
    } catch {
      reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "invalid relay device route" });
    }
  });
  app.post<{
    Params: { routeId: string; deviceId: string };
    Body: Record<string, unknown>;
  }>("/v1/routes/:routeId/devices/:deviceId/promote", { preHandler: requireHost }, async (request, reply) => {
    try {
      const body = strictInternalBody(request.body, ["expectedCredentialHash", "credentialHash"]);
      const routeId = safeId(request.params.routeId, "route id");
      const deviceId = safeId(request.params.deviceId, "device id");
      const expectedCredentialHash = safeCredentialHash(body.expectedCredentialHash);
      const credentialHash = safeCredentialHash(body.credentialHash);
      if (tokenMatches(expectedCredentialHash, credentialHash)) throw new Error("relay credentials must differ");

      const current = store.getDevice(routeId, deviceId, now());
      if (!current) {
        reply.code(404).send({ code: "RELAY_DEVICE_NOT_FOUND", error: "relay device not found" });
        return;
      }
      if (current.expiresAt === undefined && tokenMatches(current.credentialHash, credentialHash)) {
        reply.code(200).send({
          device: {
            routeId: current.routeId,
            deviceId: current.deviceId,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
            expiresAt: null,
          },
        });
        return;
      }
      if (current.expiresAt === undefined || !tokenMatches(current.credentialHash, expectedCredentialHash)) {
        reply.code(409).send({
          code: "RELAY_DEVICE_CREDENTIAL_CONFLICT",
          error: "relay device credential conflict",
        });
        return;
      }
      const device = store.putDevice({ routeId, deviceId, credentialHash }, now());
      reply.code(200).send({
        device: {
          routeId: device.routeId,
          deviceId: device.deviceId,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
          expiresAt: null,
        },
      });
    } catch {
      reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "invalid relay device promotion" });
    }
  });
  app.delete<{ Params: { routeId: string; deviceId: string }; Body: Record<string, unknown> | undefined }>(
    "/v1/routes/:routeId/devices/:deviceId",
    { preHandler: requireHost },
    async (request, reply) => {
      let routeId: string;
      let deviceId: string;
      let expectedCredentialHash: string | undefined;
      try {
        routeId = safeId(request.params.routeId, "route id");
        deviceId = safeId(request.params.deviceId, "device id");
        if (request.body !== undefined) {
          const body = strictInternalBody(request.body, ["expectedCredentialHash"]);
          expectedCredentialHash = safeCredentialHash(body.expectedCredentialHash);
        }
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "invalid relay device" });
        return;
      }

      const current = store.getDevice(routeId, deviceId, now());
      if (!current) {
        if (expectedCredentialHash) {
          reply.code(204).send();
          return;
        }
        reply.code(404).send({ code: "RELAY_DEVICE_NOT_FOUND", error: "relay device not found" });
        return;
      }
      if (expectedCredentialHash && !tokenMatches(current.credentialHash, expectedCredentialHash)) {
        reply.code(409).send({
          code: "RELAY_DEVICE_CREDENTIAL_CONFLICT",
          error: "relay device credential conflict",
        });
        return;
      }
      store.revokeDevice(routeId, deviceId);
      deviceRates.delete(deviceRateKey(routeId, deviceId));
      const live = hosts.get(routeId)?.devices.get(deviceId);
      live?.socket.close(4403, "device revoked");
      reply.code(204).send();
    },
  );

  const closeDevice = (device: LiveDevice, code = 1000, reason = "device disconnected"): void => {
    if (device.closed) return;
    device.closed = true;
    if (device.idle) clearTimeout(device.idle);
    devicesByChannel.delete(device.channelId);
    const host = hosts.get(device.routeId);
    if (host?.devices.get(device.deviceId) === device) host.devices.delete(device.deviceId);
    metrics.activeDevices = Math.max(0, metrics.activeDevices - 1);
    if (host && !safeSend(host.socket, { t: "peer-close", channelId: device.channelId, code }, maxQueueBytes)) {
      metrics.droppedFrames += 1;
      // If the host cannot observe channel closure, reset the whole host transport so its reconnect starts from the
      // broker's authoritative empty channel map instead of retaining a ghost peer indefinitely.
      closeHost(host, 4408, "relay backpressure");
    }
    if (device.socket.readyState === device.socket.OPEN) device.socket.close(code, reason);
  };
  const touchDevice = (device: LiveDevice) => {
    if (device.idle) clearTimeout(device.idle);
    device.idle = setTimeout(() => closeDevice(device, 4408, "idle timeout"), idleTimeoutMs);
    device.idle.unref?.();
  };
  const closeHost = (host: LiveHost, code = 1000, reason = "host disconnected"): void => {
    if (host.closed) return;
    host.closed = true;
    if (host.idle) clearTimeout(host.idle);
    if (hosts.get(host.routeId) === host) hosts.delete(host.routeId);
    for (const device of [...host.devices.values()]) closeDevice(device, 4412, "host unavailable");
    metrics.activeHosts = Math.max(0, metrics.activeHosts - 1);
    if (host.socket.readyState === host.socket.OPEN) host.socket.close(code, reason);
  };
  const touchHost = (host: LiveHost) => {
    if (host.idle) clearTimeout(host.idle);
    host.idle = setTimeout(() => closeHost(host, 4408, "idle timeout"), idleTimeoutMs);
    host.idle.unref?.();
  };

  if (accountStore) {
    const accountEnvelope = (account: RelayAccountRecord) => ({
      account,
      usage: { routes: store.listRoutesByOwner(account.id, now()).length, maxRoutes: account.maxRoutes },
    });
    const closeAccountRoutes = (accountId: string, reason: string) => {
      for (const host of [...hosts.values()]) if (host.ownerAccountId === accountId) closeHost(host, 4403, reason);
    };
    const purgeAccountRoutes = (accountId: string) => {
      // Close from in-memory ownership first. Even if durable route cleanup then fails, a committed suspension or
      // deletion cannot leave an already-authenticated route forwarding until the next process restart.
      closeAccountRoutes(accountId, "account deleted");
      for (const route of store.listRoutesByOwner(accountId, now())) {
        store.deleteRoute(route.id);
        clearRouteRates(route.id);
      }
    };
    for (const listedRoute of store.listRoutes(now())) {
      const route = store.getRoute(listedRoute.id);
      if (!route?.ownerAccountId) continue;
      const owner = accountStore.getAccount(route.ownerAccountId);
      if (!owner || owner.status === "deleted") {
        store.deleteRoute(route.id);
        clearRouteRates(route.id);
      }
    }
    const ownedRoute = (accountId: string, routeId: string) => {
      const route = store.getRoute(routeId);
      return route?.ownerAccountId === accountId ? route : undefined;
    };

    const internalRouteEnvelope = (accountId: string, routeId: string) => {
      const route = ownedRoute(accountId, routeId);
      if (!route) return;
      return {
        accountId,
        route: publicRoute({ ...route, deviceCount: store.countDevices(route.id, now()) }),
        status: {
          hostOnline: hosts.has(route.id),
          activeDevices: hosts.get(route.id)?.devices.size ?? 0,
        },
        connection: { path: "/v1/connect", protocolVersion: BLIND_RELAY_PROTOCOL_VERSION },
      };
    };
    const internalDeviceEnvelope = (
      accountId: string,
      device: {
        routeId: string;
        deviceId: string;
        createdAt: number;
        updatedAt: number;
        expiresAt?: number;
      },
    ) => ({
      accountId,
      device: {
        routeId: device.routeId,
        deviceId: device.deviceId,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
        expiresAt: device.expiresAt ?? null,
      },
    });
    const closeAndDeleteRoute = (routeId: string, reason: string): boolean => {
      const route = store.getRoute(routeId);
      if (!route) return false;
      const host = hosts.get(routeId);
      if (host) closeHost(host, 4403, reason);
      const deleted = store.deleteRoute(routeId);
      if (deleted) clearRouteRates(routeId);
      return deleted;
    };
    const accountRevisionConflict = (reply: FastifyReply, account: RelayAccountRecord) =>
      reply.code(409).send({
        code: "RELAY_ACCOUNT_REVISION_CONFLICT",
        error: "relay account revision conflict",
        current: accountEnvelope(account),
      });

    type InternalAccountProvisionRequest = {
      Params: { accountId: string };
      Body: Record<string, unknown>;
    };
    app.put<InternalAccountProvisionRequest>(
      "/internal/v1/accounts/:accountId",
      { preHandler: requireRoot },
      async (request, reply) => {
        let accountId: string;
        let input: CreateRelayAccountInput;
        try {
          const body = strictInternalBody(request.body, [
            "label",
            "plan",
            "maxRoutes",
            "maxDevicesPerRoute",
            "credentialHash",
            "credentialLookup",
          ]);
          accountId = safeAccountId(request.params.accountId);
          input = {
            id: accountId,
            label: safeAccountLabel(body.label),
            plan: safeAccountPlan(body.plan),
            maxRoutes: safeAccountLimit(body.maxRoutes, 10_000),
            maxDevicesPerRoute: safeAccountLimit(body.maxDevicesPerRoute, 100_000),
            ...safeAccountCredentialMaterial(body),
          };
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
          return;
        }

        const existing = accountStore.getAccount(accountId);
        if (existing) {
          const matches =
            existing.status !== "deleted" &&
            existing.label === input.label &&
            existing.plan === input.plan &&
            existing.maxRoutes === input.maxRoutes &&
            existing.maxDevicesPerRoute === input.maxDevicesPerRoute &&
            accountStore.credentialMatches(accountId, input);
          if (!matches) {
            reply.code(409).send({ code: "RELAY_ACCOUNT_EXISTS", error: "relay account already exists" });
            return;
          }
          reply.code(200).send(accountEnvelope(existing));
          return;
        }

        try {
          const account = accountStore.createAccount(input);
          reply.code(201).send(accountEnvelope(account));
        } catch (error) {
          if (
            (error as Error).message === "relay account already exists" ||
            (error as Error).message === "relay account credential already exists"
          ) {
            reply.code(409).send({ code: "RELAY_ACCOUNT_EXISTS", error: "relay account already exists" });
            return;
          }
          throw error;
        }
      },
    );

    app.get<{ Params: { accountId: string } }>(
      "/internal/v1/accounts/:accountId/status",
      { preHandler: requireRoot },
      async (request, reply) => {
        let account: RelayAccountRecord | undefined;
        try {
          account = accountStore.getAccount(safeAccountId(request.params.accountId));
        } catch {
          /* Invalid and unknown account ids are intentionally indistinguishable. */
        }
        if (!account || account.status === "deleted") {
          reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
          return;
        }
        reply.code(200).send(accountEnvelope(account));
      },
    );

    app.put<{
      Params: { accountId: string };
      Body: Record<string, unknown>;
    }>("/internal/v1/accounts/:accountId/metadata", { preHandler: requireRoot }, async (request, reply) => {
      let accountId: string;
      let expectedRevision: number;
      let update: UpdateRelayAccountInput;
      try {
        const body = strictInternalBody(request.body, [
          "expectedRevision",
          "label",
          "plan",
          "maxRoutes",
          "maxDevicesPerRoute",
        ]);
        accountId = safeAccountId(request.params.accountId);
        expectedRevision = safeRevision(body.expectedRevision);
        update = {
          label: safeAccountLabel(body.label),
          plan: safeAccountPlan(body.plan),
          maxRoutes: safeAccountLimit(body.maxRoutes, 10_000),
          maxDevicesPerRoute: safeAccountLimit(body.maxDevicesPerRoute, 100_000),
        };
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
        return;
      }
      const current = accountStore.getAccount(accountId);
      if (!current || current.status === "deleted") {
        reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
        return;
      }
      const matches =
        current.label === update.label &&
        current.plan === update.plan &&
        current.maxRoutes === update.maxRoutes &&
        current.maxDevicesPerRoute === update.maxDevicesPerRoute;
      if (matches && (current.revision === expectedRevision || current.revision === expectedRevision + 1)) {
        reply.code(200).send(accountEnvelope(current));
        return;
      }
      if (current.revision !== expectedRevision) {
        accountRevisionConflict(reply, current);
        return;
      }
      try {
        const account = accountStore.updateAccount(accountId, update, expectedRevision);
        if (!account) {
          reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
          return;
        }
        reply.code(200).send(accountEnvelope(account));
      } catch (error) {
        if (error instanceof RelayAccountRevisionConflictError) {
          accountRevisionConflict(reply, error.current);
          return;
        }
        throw error;
      }
    });

    app.put<{
      Params: { accountId: string };
      Body: Record<string, unknown>;
    }>("/internal/v1/accounts/:accountId/credential", { preHandler: requireRoot }, async (request, reply) => {
      let accountId: string;
      let expectedRevision: number;
      let credential: RelayAccountCredentialMaterial;
      try {
        const body = strictInternalBody(request.body, ["expectedRevision", "credentialHash", "credentialLookup"]);
        accountId = safeAccountId(request.params.accountId);
        expectedRevision = safeRevision(body.expectedRevision);
        credential = safeAccountCredentialMaterial(body);
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
        return;
      }
      const current = accountStore.getAccount(accountId);
      if (!current || current.status === "deleted") {
        reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
        return;
      }
      if (accountStore.credentialMatches(accountId, credential)) {
        if (current.revision === expectedRevision || current.revision === expectedRevision + 1) {
          reply.code(200).send(accountEnvelope(current));
          return;
        }
        accountRevisionConflict(reply, current);
        return;
      }
      if (current.revision !== expectedRevision) {
        accountRevisionConflict(reply, current);
        return;
      }
      try {
        const account = accountStore.rotateCredential(accountId, credential, expectedRevision);
        if (!account) {
          reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
          return;
        }
        reply.code(200).send(accountEnvelope(account));
      } catch (error) {
        if (error instanceof RelayAccountRevisionConflictError) {
          accountRevisionConflict(reply, error.current);
          return;
        }
        if ((error as Error).message === "relay account credential already exists") {
          reply.code(409).send({ code: "RELAY_ACCOUNT_CREDENTIAL_CONFLICT", error: "relay credential conflict" });
          return;
        }
        throw error;
      }
    });

    app.delete<{
      Params: { accountId: string };
      Body: { expectedRevision?: unknown };
    }>("/internal/v1/accounts/:accountId", { preHandler: requireRoot }, async (request, reply) => {
      let accountId: string;
      let expectedRevision: number;
      try {
        const body = strictInternalBody(request.body, ["expectedRevision"]);
        accountId = safeAccountId(request.params.accountId);
        expectedRevision = safeRevision(body.expectedRevision);
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
        return;
      }
      const current = accountStore.getAccount(accountId);
      if (!current || current.status === "deleted") {
        reply.code(204).send();
        return;
      }
      if (current.revision !== expectedRevision) {
        accountRevisionConflict(reply, current);
        return;
      }
      try {
        const account = accountStore.updateAccount(accountId, { status: "deleted" }, expectedRevision);
        if (account) purgeAccountRoutes(account.id);
        reply.code(204).send();
      } catch (error) {
        if (error instanceof RelayAccountRevisionConflictError) {
          accountRevisionConflict(reply, error.current);
          return;
        }
        throw error;
      }
    });

    app.put<{
      Params: { accountId: string; routeId: string };
      Body: Record<string, unknown>;
    }>("/internal/v1/accounts/:accountId/routes/:routeId", { preHandler: requireRoot }, async (request, reply) => {
      let accountId: string;
      let routeId: string;
      let label: string;
      let credentialHash: string;
      try {
        const body = strictInternalBody(request.body, ["label", "credentialHash"]);
        accountId = safeAccountId(request.params.accountId);
        routeId = safeId(request.params.routeId, "route id");
        label = safeLabel(body.label);
        credentialHash = safeRouteCredentialHash(body);
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_ROUTE", error: "invalid relay route" });
        return;
      }
      const account = accountStore.getAccount(accountId);
      if (!account || account.status === "deleted") {
        reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
        return;
      }
      if (account.status !== "active") {
        reply.code(409).send({ code: "RELAY_ACCOUNT_UNAVAILABLE", error: "relay account unavailable" });
        return;
      }
      const existing = store.getRoute(routeId);
      if (existing) {
        if (
          existing.ownerAccountId !== accountId ||
          existing.label !== label ||
          !tokenMatches(existing.hostCredentialHash, credentialHash)
        ) {
          reply.code(409).send({ code: "RELAY_ROUTE_EXISTS", error: "relay route already exists" });
          return;
        }
        reply.code(200).send(internalRouteEnvelope(accountId, routeId));
        return;
      }
      if (store.listRoutesByOwner(accountId, now()).length >= account.maxRoutes) {
        reply.code(429).send({ code: "RELAY_ROUTE_LIMIT", error: "relay route limit reached" });
        return;
      }
      try {
        store.createRoute({ id: routeId, label, hostCredentialHash: credentialHash, ownerAccountId: accountId });
        reply.code(201).send(internalRouteEnvelope(accountId, routeId));
      } catch (error) {
        if ((error as Error).message === "relay route already exists") {
          reply.code(409).send({ code: "RELAY_ROUTE_EXISTS", error: "relay route already exists" });
          return;
        }
        throw error;
      }
    });

    app.get<{ Params: { accountId: string; routeId: string } }>(
      "/internal/v1/accounts/:accountId/routes/:routeId/status",
      { preHandler: requireRoot },
      async (request, reply) => {
        let route;
        try {
          route = internalRouteEnvelope(
            safeAccountId(request.params.accountId),
            safeId(request.params.routeId, "route id"),
          );
        } catch {
          /* Invalid and unknown route ids are intentionally indistinguishable. */
        }
        if (!route) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }
        reply.code(200).send(route);
      },
    );

    app.put<{
      Params: { accountId: string; routeId: string; deviceId: string };
      Body: Record<string, unknown>;
    }>(
      "/internal/v1/accounts/:accountId/routes/:routeId/devices/:deviceId",
      { preHandler: requireRoot },
      async (request, reply) => {
        let accountId: string;
        let routeId: string;
        let deviceId: string;
        let credentialHash: string;
        let expiresAt: number;
        try {
          const body = strictInternalBody(request.body, ["credentialHash", "expiresAt"]);
          accountId = safeAccountId(request.params.accountId);
          routeId = safeId(request.params.routeId, "route id");
          deviceId = safeId(request.params.deviceId, "device id");
          credentialHash = safeCredentialHash(body.credentialHash);
          const parsedExpiry = safeExpiry(body.expiresAt, now());
          if (parsedExpiry === undefined) throw new Error("temporary relay device expiry is required");
          expiresAt = parsedExpiry;
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "invalid relay device" });
          return;
        }

        const account = accountStore.getAccount(accountId);
        if (!account || account.status === "deleted") {
          reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
          return;
        }
        if (account.status !== "active") {
          reply.code(409).send({ code: "RELAY_ACCOUNT_UNAVAILABLE", error: "relay account unavailable" });
          return;
        }
        if (!ownedRoute(accountId, routeId)) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }

        const current = store.getDevice(routeId, deviceId, now());
        if (current) {
          if (tokenMatches(current.credentialHash, credentialHash) && current.expiresAt === expiresAt) {
            reply.code(200).send(internalDeviceEnvelope(accountId, current));
            return;
          }
          reply.code(409).send({
            code: "RELAY_DEVICE_CREDENTIAL_CONFLICT",
            error: "relay device credential conflict",
            current: internalDeviceEnvelope(accountId, current),
          });
          return;
        }
        if (store.countDevices(routeId, now()) >= account.maxDevicesPerRoute) {
          reply.code(429).send({ code: "RELAY_DEVICE_LIMIT", error: "relay device limit reached" });
          return;
        }
        const device = store.putDevice({ routeId, deviceId, credentialHash, expiresAt }, now());
        reply.code(201).send(internalDeviceEnvelope(accountId, device));
      },
    );

    app.post<{
      Params: { accountId: string; routeId: string; deviceId: string };
      Body: Record<string, unknown>;
    }>(
      "/internal/v1/accounts/:accountId/routes/:routeId/devices/:deviceId/promote",
      { preHandler: requireRoot },
      async (request, reply) => {
        let accountId: string;
        let routeId: string;
        let deviceId: string;
        let expectedCredentialHash: string;
        let credentialHash: string;
        try {
          const body = strictInternalBody(request.body, ["expectedCredentialHash", "credentialHash"]);
          accountId = safeAccountId(request.params.accountId);
          routeId = safeId(request.params.routeId, "route id");
          deviceId = safeId(request.params.deviceId, "device id");
          expectedCredentialHash = safeCredentialHash(body.expectedCredentialHash);
          credentialHash = safeCredentialHash(body.credentialHash);
          if (tokenMatches(expectedCredentialHash, credentialHash)) throw new Error("relay credentials must differ");
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "invalid relay device promotion" });
          return;
        }

        const account = accountStore.getAccount(accountId);
        if (!account || account.status === "deleted") {
          reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
          return;
        }
        if (account.status !== "active") {
          reply.code(409).send({ code: "RELAY_ACCOUNT_UNAVAILABLE", error: "relay account unavailable" });
          return;
        }
        if (!ownedRoute(accountId, routeId)) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }

        const current = store.getDevice(routeId, deviceId, now());
        if (!current) {
          reply.code(404).send({ code: "RELAY_DEVICE_NOT_FOUND", error: "relay device not found" });
          return;
        }
        if (current.expiresAt === undefined && tokenMatches(current.credentialHash, credentialHash)) {
          reply.code(200).send(internalDeviceEnvelope(accountId, current));
          return;
        }
        if (current.expiresAt === undefined || !tokenMatches(current.credentialHash, expectedCredentialHash)) {
          reply.code(409).send({
            code: "RELAY_DEVICE_CREDENTIAL_CONFLICT",
            error: "relay device credential conflict",
            current: internalDeviceEnvelope(accountId, current),
          });
          return;
        }
        const device = store.putDevice({ routeId, deviceId, credentialHash }, now());
        reply.code(200).send(internalDeviceEnvelope(accountId, device));
      },
    );

    app.delete<{
      Params: { accountId: string; routeId: string; deviceId: string };
      Body: Record<string, unknown>;
    }>(
      "/internal/v1/accounts/:accountId/routes/:routeId/devices/:deviceId",
      { preHandler: requireRoot },
      async (request, reply) => {
        let accountId: string;
        let routeId: string;
        let deviceId: string;
        let expectedCredentialHash: string;
        try {
          const body = strictInternalBody(request.body, ["expectedCredentialHash"]);
          accountId = safeAccountId(request.params.accountId);
          routeId = safeId(request.params.routeId, "route id");
          deviceId = safeId(request.params.deviceId, "device id");
          expectedCredentialHash = safeCredentialHash(body.expectedCredentialHash);
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_DEVICE", error: "invalid relay device" });
          return;
        }

        const account = accountStore.getAccount(accountId);
        if (!account || account.status === "deleted") {
          reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
          return;
        }
        if (!ownedRoute(accountId, routeId)) {
          reply.code(204).send();
          return;
        }
        const current = store.getDevice(routeId, deviceId, now());
        if (!current) {
          reply.code(204).send();
          return;
        }
        if (!tokenMatches(current.credentialHash, expectedCredentialHash)) {
          reply.code(409).send({
            code: "RELAY_DEVICE_CREDENTIAL_CONFLICT",
            error: "relay device credential conflict",
            current: internalDeviceEnvelope(accountId, current),
          });
          return;
        }
        store.revokeDevice(routeId, deviceId);
        deviceRates.delete(deviceRateKey(routeId, deviceId));
        const live = hosts.get(routeId)?.devices.get(deviceId);
        live?.socket.close(4403, "device revoked");
        reply.code(204).send();
      },
    );

    app.put<{
      Params: { accountId: string; routeId: string };
      Body: Record<string, unknown>;
    }>(
      "/internal/v1/accounts/:accountId/routes/:routeId/credential",
      { preHandler: requireRoot },
      async (request, reply) => {
        let accountId: string;
        let routeId: string;
        let expectedCredentialHash: string;
        let credentialHash: string;
        try {
          const body = strictInternalBody(request.body, ["expectedCredentialHash", "credentialHash"]);
          accountId = safeAccountId(request.params.accountId);
          routeId = safeId(request.params.routeId, "route id");
          expectedCredentialHash = safeRouteCredentialHash(body, "expectedCredentialHash");
          credentialHash = safeRouteCredentialHash(body);
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_CREDENTIAL", error: "invalid relay credential hash" });
          return;
        }
        const route = ownedRoute(accountId, routeId);
        if (!route) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }
        if (tokenMatches(route.hostCredentialHash, credentialHash)) {
          reply.code(200).send(internalRouteEnvelope(accountId, routeId));
          return;
        }
        if (!tokenMatches(route.hostCredentialHash, expectedCredentialHash)) {
          reply.code(409).send({
            code: "RELAY_ROUTE_CREDENTIAL_CONFLICT",
            error: "relay route credential conflict",
            current: internalRouteEnvelope(accountId, routeId),
          });
          return;
        }
        if (!store.rotateHostCredential(routeId, credentialHash, now())) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }
        const host = hosts.get(routeId);
        if (host) closeHost(host, 4409, "host credential rotated");
        reply.code(200).send(internalRouteEnvelope(accountId, routeId));
      },
    );

    app.delete<{
      Params: { accountId: string; routeId: string };
      Body: Record<string, unknown>;
    }>("/internal/v1/accounts/:accountId/routes/:routeId", { preHandler: requireRoot }, async (request, reply) => {
      let accountId: string;
      let routeId: string;
      let expectedCredentialHash: string;
      try {
        const body = strictInternalBody(request.body, ["expectedCredentialHash"]);
        accountId = safeAccountId(request.params.accountId);
        routeId = safeId(request.params.routeId, "route id");
        expectedCredentialHash = safeRouteCredentialHash(body, "expectedCredentialHash");
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_ROUTE", error: "invalid relay route" });
        return;
      }
      const route = ownedRoute(accountId, routeId);
      if (!route) {
        reply.code(204).send();
        return;
      }
      if (!tokenMatches(route.hostCredentialHash, expectedCredentialHash)) {
        reply.code(409).send({
          code: "RELAY_ROUTE_CREDENTIAL_CONFLICT",
          error: "relay route credential conflict",
          current: internalRouteEnvelope(accountId, routeId),
        });
        return;
      }
      closeAndDeleteRoute(routeId, "route deleted");
      reply.code(204).send();
    });

    app.get("/v1/accounts", { preHandler: requireRoot }, async () => ({
      accounts: accountStore.listAccounts().map((account) => accountEnvelope(account)),
    }));
    const createAccountHandler =
      (clientHashedOnly: boolean) =>
      async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply: FastifyReply) => {
        try {
          const hasCredentialHash = request.body?.credentialHash !== undefined;
          const hasCredentialLookup = request.body?.credentialLookup !== undefined;
          if (clientHashedOnly && (!hasCredentialHash || !hasCredentialLookup)) {
            throw new Error("client-hashed account credential material is required");
          }
          const suppliedCredentialMaterial = hasCredentialHash || hasCredentialLookup;
          const accountCredential = suppliedCredentialMaterial ? undefined : generateRelayAccountCredential();
          const credential: RelayAccountCredentialInput = suppliedCredentialMaterial
            ? {
                credentialHash: request.body?.credentialHash as string,
                credentialLookup: request.body?.credentialLookup as string,
              }
            : accountCredential!;
          const account = accountStore.createAccount({
            label: request.body?.label as string,
            ...(request.body?.plan === undefined ? {} : { plan: request.body.plan }),
            ...(request.body?.maxRoutes === undefined ? {} : { maxRoutes: request.body.maxRoutes }),
            ...(request.body?.maxDevicesPerRoute === undefined
              ? {}
              : { maxDevicesPerRoute: request.body.maxDevicesPerRoute }),
            ...(typeof credential === "string"
              ? { credential }
              : {
                  credentialHash: credential.credentialHash,
                  credentialLookup: credential.credentialLookup,
                }),
          } as CreateRelayAccountInput);
          reply.code(201).send({
            ...accountEnvelope(account),
            ...(accountCredential === undefined ? {} : { accountCredential }),
          });
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
        }
      };
    app.post<{ Body: Record<string, unknown> }>(
      "/v1/accounts",
      { preHandler: requireRoot },
      createAccountHandler(false),
    );
    app.post<{ Body: Record<string, unknown> }>(
      "/v1/accounts/client-hashed",
      { preHandler: requireRoot },
      createAccountHandler(true),
    );
    app.patch<{ Params: { accountId: string }; Body: Record<string, unknown> }>(
      "/v1/accounts/:accountId",
      { preHandler: requireRoot },
      async (request, reply) => {
        try {
          const account = accountStore.updateAccount(
            request.params.accountId,
            request.body as UpdateRelayAccountInput,
            safeRevision(request.body?.expectedRevision),
          );
          if (!account) {
            reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
            return;
          }
          if (account.status === "deleted") purgeAccountRoutes(account.id);
          else if (account.status !== "active") closeAccountRoutes(account.id, "account unavailable");
          reply.code(200).send(accountEnvelope(account));
        } catch (error) {
          if (error instanceof RelayAccountRevisionConflictError) {
            reply.code(409).send({
              code: "RELAY_ACCOUNT_REVISION_CONFLICT",
              error: "relay account revision conflict",
              current: accountEnvelope(error.current),
            });
            return;
          }
          reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
        }
      },
    );
    type RotateAccountRequest = {
      Params: { accountId: string };
      Body: { expectedRevision?: unknown; credentialHash?: unknown; credentialLookup?: unknown };
    };
    const rotateAccountHandler =
      (clientHashedOnly: boolean) => async (request: FastifyRequest<RotateAccountRequest>, reply: FastifyReply) => {
        try {
          const hasCredentialHash = request.body?.credentialHash !== undefined;
          const hasCredentialLookup = request.body?.credentialLookup !== undefined;
          if (clientHashedOnly && (!hasCredentialHash || !hasCredentialLookup)) {
            throw new Error("client-hashed account credential material is required");
          }
          const suppliedCredentialMaterial = hasCredentialHash || hasCredentialLookup;
          const accountCredential = suppliedCredentialMaterial ? undefined : generateRelayAccountCredential();
          const credential: RelayAccountCredentialInput = suppliedCredentialMaterial
            ? {
                credentialHash: request.body?.credentialHash as string,
                credentialLookup: request.body?.credentialLookup as string,
              }
            : accountCredential!;
          const account = accountStore.rotateCredential(
            request.params.accountId,
            credential,
            safeRevision(request.body?.expectedRevision),
          );
          if (!account) {
            reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
            return;
          }
          reply.code(200).send({
            ...accountEnvelope(account),
            ...(accountCredential === undefined ? {} : { accountCredential }),
          });
        } catch (error) {
          if (error instanceof RelayAccountRevisionConflictError) {
            reply.code(409).send({
              code: "RELAY_ACCOUNT_REVISION_CONFLICT",
              error: "relay account revision conflict",
              current: accountEnvelope(error.current),
            });
            return;
          }
          reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
        }
      };
    app.post<RotateAccountRequest>(
      "/v1/accounts/:accountId/credential",
      { preHandler: requireRoot },
      rotateAccountHandler(false),
    );
    app.post<RotateAccountRequest>(
      "/v1/accounts/:accountId/credential/client-hashed",
      { preHandler: requireRoot },
      rotateAccountHandler(true),
    );

    app.get("/v1/account/recovery", { preHandler: requireRecoverableAccount }, async (request) =>
      accountEnvelope(authenticatedAccounts.get(request)!),
    );
    app.get("/v1/account", { preHandler: requireAccount }, async (request) =>
      accountEnvelope(authenticatedAccounts.get(request)!),
    );
    app.get("/v1/account/routes", { preHandler: requireAccount }, async (request) => ({
      routes: store.listRoutesByOwner(authenticatedAccounts.get(request)!.id, now()).map((route) => ({
        ...publicRoute(route),
        hostOnline: hosts.has(route.id),
      })),
    }));
    app.post<{ Body: { id?: unknown; label?: unknown; credentialHash?: unknown } }>(
      "/v1/account/routes",
      { preHandler: requireAccount },
      async (request, reply) => {
        const account = authenticatedAccounts.get(request)!;
        let id: string;
        let label: string;
        let credentialHash: string;
        try {
          id = safeId(request.body?.id, "route id");
          label = safeLabel(request.body?.label);
          credentialHash = safeCredentialHash(request.body?.credentialHash);
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_ROUTE", error: "invalid relay route" });
          return;
        }
        const existing = store.getRoute(id);
        if (existing) {
          if (
            existing.ownerAccountId !== account.id ||
            existing.label !== label ||
            !tokenMatches(existing.hostCredentialHash, credentialHash)
          ) {
            reply.code(409).send({ code: "RELAY_ROUTE_EXISTS", error: "relay route already exists" });
            return;
          }
          reply.code(200).send({
            route: {
              ...publicRoute({ ...existing, deviceCount: store.countDevices(existing.id, now()) }),
              hostOnline: hosts.has(id),
            },
            connection: { path: "/v1/connect", protocolVersion: BLIND_RELAY_PROTOCOL_VERSION },
          });
          return;
        }
        if (store.listRoutesByOwner(account.id, now()).length >= account.maxRoutes) {
          reply.code(429).send({ code: "RELAY_ROUTE_LIMIT", error: "relay route limit reached" });
          return;
        }
        try {
          const route = store.createRoute({
            id,
            label,
            hostCredentialHash: credentialHash,
            ownerAccountId: account.id,
          });
          reply.code(201).send({
            route: { ...publicRoute({ ...route, deviceCount: 0 }), hostOnline: false },
            connection: { path: "/v1/connect", protocolVersion: BLIND_RELAY_PROTOCOL_VERSION },
          });
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_ROUTE", error: "invalid relay route" });
        }
      },
    );
    app.delete<{ Params: { routeId: string } }>(
      "/v1/account/routes/:routeId",
      { preHandler: requireAccount },
      async (request, reply) => {
        const account = authenticatedAccounts.get(request)!;
        let removed = false;
        try {
          removed = !!ownedRoute(account.id, request.params.routeId) && store.deleteRoute(request.params.routeId);
        } catch {
          /* Invalid and unknown route ids are intentionally indistinguishable. */
        }
        if (!removed) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }
        clearRouteRates(request.params.routeId);
        const host = hosts.get(request.params.routeId);
        if (host) closeHost(host, 4403, "route deleted");
        reply.code(204).send();
      },
    );
    app.post<{ Params: { routeId: string }; Body: { credentialHash?: unknown } }>(
      "/v1/account/routes/:routeId/credential",
      { preHandler: requireAccount },
      async (request, reply) => {
        const account = authenticatedAccounts.get(request)!;
        try {
          if (!ownedRoute(account.id, request.params.routeId)) {
            reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
            return;
          }
        } catch {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }
        let credentialHash: string;
        try {
          credentialHash = safeCredentialHash(request.body?.credentialHash);
        } catch {
          reply.code(400).send({ code: "INVALID_RELAY_CREDENTIAL", error: "invalid relay credential hash" });
          return;
        }
        if (!store.rotateHostCredential(request.params.routeId, credentialHash, now())) {
          reply.code(404).send({ code: "RELAY_ROUTE_NOT_FOUND", error: "relay route not found" });
          return;
        }
        const host = hosts.get(request.params.routeId);
        if (host) closeHost(host, 4409, "host credential rotated");
        reply.code(204).send();
      },
    );
  }

  app.register(websocket, { options: { maxPayload: maxEnvelopeBytes, perMessageDeflate: false } });
  app.register(async (scope) => {
    scope.get("/v1/connect", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
      if (sockets.size >= maxTotalConnections) {
        metrics.rejectedConnections += 1;
        socket.close(4429, "relay connection limit");
        return;
      }
      sockets.add(socket);
      let authenticated = false;
      let liveHost: LiveHost | undefined;
      let liveDevice: LiveDevice | undefined;
      const handshakeTimer = setTimeout(() => socket.close(4401, "authentication timeout"), handshakeTimeoutMs);
      handshakeTimer.unref?.();
      const reject = (code: number, reason: string) => {
        metrics.rejectedConnections += 1;
        socket.close(code, reason);
      };
      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          metrics.droppedFrames += 1;
          reject(4400, "text envelope required");
          return;
        }
        if (!authenticated) {
          try {
            const hello = parseAuthHello(parseJson(raw, 8 * 1024));
            const presentedOrigin = request.headers.origin;
            const origin = typeof presentedOrigin === "string" ? normalizeOrigin(presentedOrigin) : undefined;
            if (
              hello.role === "device" &&
              allowedOrigins.size > 0 &&
              presentedOrigin !== undefined &&
              (!origin || !allowedOrigins.has(origin))
            ) {
              reject(4403, "origin denied");
              return;
            }
            if (hello.role === "host") {
              const route = store.getRoute(hello.routeId);
              if (
                !route ||
                (route.ownerAccountId !== undefined &&
                  accountStore?.getAccount(route.ownerAccountId)?.status !== "active") ||
                !store.authenticateHost(hello.routeId, hello.credential)
              ) {
                reject(4401, "authentication failed");
                return;
              }
              const rate = rateWindowFor(hostRates, hello.routeId);
              if (!rate || !consumeRate(rate, Buffer.byteLength(raw.toString()))) {
                reject(4429, "relay identity rate limit");
                return;
              }
              const previous = hosts.get(hello.routeId);
              if (previous) closeHost(previous, 4409, "superseded host");
              liveHost = {
                socket,
                routeId: hello.routeId,
                ...(route.ownerAccountId === undefined ? {} : { ownerAccountId: route.ownerAccountId }),
                devices: new Map(),
                rate,
                closed: false,
              };
              hosts.set(hello.routeId, liveHost);
              metrics.activeHosts += 1;
              touchHost(liveHost);
              if (!safeSend(socket, { t: "ready", role: "host", protocolVersion: 1 }, maxQueueBytes)) {
                metrics.rejectedConnections += 1;
                closeHost(liveHost, 4408, "relay backpressure");
                return;
              }
            } else {
              if (
                !routeAccountIsActive(hello.routeId) ||
                !store.authenticateDevice(hello.routeId, hello.deviceId, hello.credential, now())
              ) {
                reject(4401, "authentication failed");
                return;
              }
              const host = hosts.get(hello.routeId);
              if (!host || host.socket.readyState !== host.socket.OPEN) {
                reject(4412, "host unavailable");
                return;
              }
              if (host.devices.size >= maxConnectionsPerRoute && !host.devices.has(hello.deviceId)) {
                reject(4429, "route connection limit");
                return;
              }
              const rate = rateWindowFor(deviceRates, deviceRateKey(hello.routeId, hello.deviceId));
              if (!rate || !consumeRate(rate, Buffer.byteLength(raw.toString()))) {
                reject(4429, "relay identity rate limit");
                return;
              }
              const previous = host.devices.get(hello.deviceId);
              if (previous) closeDevice(previous, 4409, "superseded device");
              const channelId = safeId(generateChannelId(), "channel id");
              liveDevice = {
                socket,
                routeId: hello.routeId,
                deviceId: hello.deviceId,
                channelId,
                rate,
                closed: false,
              };
              host.devices.set(hello.deviceId, liveDevice);
              devicesByChannel.set(channelId, liveDevice);
              metrics.activeDevices += 1;
              touchDevice(liveDevice);
              if (!safeSend(socket, { t: "ready", role: "device", protocolVersion: 1, channelId }, maxQueueBytes)) {
                metrics.rejectedConnections += 1;
                closeDevice(liveDevice, 4408, "relay backpressure");
                return;
              }
              if (!safeSend(host.socket, { t: "peer-open", channelId, deviceId: hello.deviceId }, maxQueueBytes)) {
                metrics.rejectedConnections += 1;
                closeDevice(liveDevice, 4408, "host backpressure");
                return;
              }
            }
            authenticated = true;
            metrics.acceptedConnections += 1;
            clearTimeout(handshakeTimer);
          } catch {
            reject(4400, "invalid authentication frame");
          }
          return;
        }
        try {
          const value = parseJson(raw, maxEnvelopeBytes);
          if (liveDevice) {
            touchDevice(liveDevice);
            if ((value as { t?: unknown })?.t === "ping") {
              if (!consumeRate(liveDevice.rate, 1)) {
                closeDevice(liveDevice, 4429, "rate limit");
                return;
              }
              if (!safeSend(socket, { t: "pong", at: now() }, maxQueueBytes)) {
                metrics.droppedFrames += 1;
                closeDevice(liveDevice, 4408, "relay backpressure");
              }
              return;
            }
            const frame = parsePayload(value, false, maxFrameBytes);
            if (!consumeRate(liveDevice.rate, frame.bytes)) {
              closeDevice(liveDevice, 4429, "rate limit");
              return;
            }
            const host = hosts.get(liveDevice.routeId);
            if (
              !host ||
              !safeSend(
                host.socket,
                { t: "frame", channelId: liveDevice.channelId, payload: frame.payload },
                maxQueueBytes,
              )
            ) {
              metrics.droppedFrames += 1;
              closeDevice(liveDevice, 4408, "host unavailable or slow");
              return;
            }
            metrics.forwardedFrames += 1;
            metrics.forwardedBytes += frame.bytes;
            return;
          }
          if (liveHost) {
            touchHost(liveHost);
            if ((value as { t?: unknown })?.t === "ping") {
              if (!consumeRate(liveHost.rate, 1)) {
                closeHost(liveHost, 4429, "rate limit");
                return;
              }
              if (!safeSend(socket, { t: "pong", at: now() }, maxQueueBytes)) {
                metrics.droppedFrames += 1;
                closeHost(liveHost, 4408, "relay backpressure");
              }
              return;
            }
            if ((value as { t?: unknown })?.t === "close-peer") {
              const channelId = safeId((value as { channelId?: unknown }).channelId, "channel id");
              if (!consumeRate(liveHost.rate, 1)) {
                closeHost(liveHost, 4429, "rate limit");
                return;
              }
              const device = devicesByChannel.get(channelId);
              if (device?.routeId === liveHost.routeId) closeDevice(device, 4400, "host closed channel");
              return;
            }
            const frame = parsePayload(value, true, maxFrameBytes);
            if (!consumeRate(liveHost.rate, frame.bytes)) {
              closeHost(liveHost, 4429, "rate limit");
              return;
            }
            const device = devicesByChannel.get(frame.channelId!);
            if (!device || device.routeId !== liveHost.routeId) {
              metrics.droppedFrames += 1;
              return;
            }
            if (!safeSend(device.socket, { t: "frame", payload: frame.payload }, maxQueueBytes)) {
              metrics.droppedFrames += 1;
              closeDevice(device, 4408, "device backpressure");
              return;
            }
            metrics.forwardedFrames += 1;
            metrics.forwardedBytes += frame.bytes;
          }
        } catch {
          metrics.droppedFrames += 1;
          if (liveDevice) closeDevice(liveDevice, 4400, "invalid relay frame");
          else if (liveHost) closeHost(liveHost, 4400, "invalid relay frame");
        }
      });
      socket.once("close", () => {
        sockets.delete(socket);
        clearTimeout(handshakeTimer);
        if (liveDevice) closeDevice(liveDevice);
        if (liveHost) closeHost(liveHost);
      });
      socket.once("error", () => {
        /* close owns cleanup */
      });
    });
  });

  app.addHook("onClose", async () => {
    for (const host of [...hosts.values()]) closeHost(host, 1001, "relay shutting down");
    for (const socket of [...sockets]) socket.close(1001, "relay shutting down");
    hostRates.clear();
    deviceRates.clear();
    if (ownsStore) store.close();
  });

  return {
    app,
    store,
    ...(accountStore ? { accountStore } : {}),
    metrics: () => ({
      ...metrics,
      activeConnections: sockets.size,
      activeHosts: hosts.size,
      activeDevices: devicesByChannel.size,
    }),
  };
}
