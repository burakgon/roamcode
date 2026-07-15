import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type WebSocket from "ws";
import {
  generateRelayAccountCredential,
  RelayAccountRevisionConflictError,
  type CreateRelayAccountInput,
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
export const BLIND_RELAY_DEFAULT_MAX_CONNECTIONS_PER_ROUTE = 64;
export const BLIND_RELAY_DEFAULT_MAX_BYTES_PER_MINUTE = 64 * 1024 * 1024;
export const BLIND_RELAY_DEFAULT_MAX_MESSAGES_PER_MINUTE = 12_000;

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
  maxConnectionsPerRoute?: number;
  maxBytesPerMinute?: number;
  maxMessagesPerMinute?: number;
  now?: () => number;
  generateChannelId?: () => string;
}

export interface BlindRelayMetrics {
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
  if (!label || label.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label)) throw new Error("invalid relay route label");
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
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return;
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
  const maxConnectionsPerRoute = options.maxConnectionsPerRoute ?? BLIND_RELAY_DEFAULT_MAX_CONNECTIONS_PER_ROUTE;
  const maxBytesPerMinute = options.maxBytesPerMinute ?? BLIND_RELAY_DEFAULT_MAX_BYTES_PER_MINUTE;
  const maxMessagesPerMinute = options.maxMessagesPerMinute ?? BLIND_RELAY_DEFAULT_MAX_MESSAGES_PER_MINUTE;
  for (const [value, minimum, maximum, label] of [
    [handshakeTimeoutMs, 1_000, 30_000, "handshake timeout"],
    [idleTimeoutMs, 10_000, 60 * 60_000, "idle timeout"],
    [maxFrameBytes, 1_024, 16 * 1024 * 1024, "frame limit"],
    [maxQueueBytes, 1_024, 64 * 1024 * 1024, "queue limit"],
    [maxConnectionsPerRoute, 1, 10_000, "connection limit"],
    [maxBytesPerMinute, 1_024, 1024 * 1024 * 1024, "byte rate"],
    [maxMessagesPerMinute, 10, 1_000_000, "message rate"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid relay ${label}`);
  }
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin).filter(Boolean));
  const generateChannelId = options.generateChannelId ?? (() => `rrc_${randomBytes(16).toString("base64url")}`);
  const hosts = new Map<string, LiveHost>();
  const devicesByChannel = new Map<string, LiveDevice>();
  const metrics: BlindRelayMetrics = {
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
    metrics: { ...metrics, activeHosts: hosts.size, activeDevices: devicesByChannel.size },
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
  app.delete<{ Params: { routeId: string; deviceId: string } }>(
    "/v1/routes/:routeId/devices/:deviceId",
    { preHandler: requireHost },
    async (request, reply) => {
      let removed = false;
      try {
        removed = store.revokeDevice(request.params.routeId, request.params.deviceId);
      } catch {
        /* invalid and unknown are the same public result */
      }
      if (!removed) {
        reply.code(404).send({ code: "RELAY_DEVICE_NOT_FOUND", error: "relay device not found" });
        return;
      }
      const live = hosts.get(request.params.routeId)?.devices.get(request.params.deviceId);
      live?.socket.close(4403, "device revoked");
      reply.code(204).send();
    },
  );

  const consumeRate = (window: RateWindow, bytes: number): boolean => {
    const current = now();
    if (current - window.startedAt >= 60_000) {
      window.startedAt = current;
      window.bytes = 0;
      window.messages = 0;
    }
    window.bytes += bytes;
    window.messages += 1;
    return window.bytes <= maxBytesPerMinute && window.messages <= maxMessagesPerMinute;
  };
  const closeDevice = (device: LiveDevice, code = 1000, reason = "device disconnected") => {
    if (device.closed) return;
    device.closed = true;
    if (device.idle) clearTimeout(device.idle);
    devicesByChannel.delete(device.channelId);
    const host = hosts.get(device.routeId);
    if (host?.devices.get(device.deviceId) === device) host.devices.delete(device.deviceId);
    metrics.activeDevices = Math.max(0, metrics.activeDevices - 1);
    if (host) safeSend(host.socket, { t: "peer-close", channelId: device.channelId, code }, maxQueueBytes);
    if (device.socket.readyState === device.socket.OPEN) device.socket.close(code, reason);
  };
  const touchDevice = (device: LiveDevice) => {
    if (device.idle) clearTimeout(device.idle);
    device.idle = setTimeout(() => closeDevice(device, 4408, "idle timeout"), idleTimeoutMs);
    device.idle.unref?.();
  };
  const closeHost = (host: LiveHost, code = 1000, reason = "host disconnected") => {
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
      for (const route of store.listRoutesByOwner(accountId, now())) {
        const host = hosts.get(route.id);
        if (host) closeHost(host, 4403, reason);
      }
    };
    const ownedRoute = (accountId: string, routeId: string) => {
      const route = store.getRoute(routeId);
      return route?.ownerAccountId === accountId ? route : undefined;
    };

    app.get("/v1/accounts", { preHandler: requireRoot }, async () => ({
      accounts: accountStore.listAccounts().map((account) => accountEnvelope(account)),
    }));
    app.post<{ Body: Record<string, unknown> }>("/v1/accounts", { preHandler: requireRoot }, async (request, reply) => {
      const accountCredential = generateRelayAccountCredential();
      try {
        const account = accountStore.createAccount({
          ...(request.body as Omit<CreateRelayAccountInput, "credential">),
          credential: accountCredential,
        });
        reply.code(201).send({ ...accountEnvelope(account), accountCredential });
      } catch {
        reply.code(400).send({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" });
      }
    });
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
          if (account.status !== "active") closeAccountRoutes(account.id, "account unavailable");
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
    app.post<{ Params: { accountId: string }; Body: { expectedRevision?: unknown } }>(
      "/v1/accounts/:accountId/credential",
      { preHandler: requireRoot },
      async (request, reply) => {
        const accountCredential = generateRelayAccountCredential();
        try {
          const account = accountStore.rotateCredential(
            request.params.accountId,
            accountCredential,
            safeRevision(request.body?.expectedRevision),
          );
          if (!account) {
            reply.code(404).send({ code: "RELAY_ACCOUNT_NOT_FOUND", error: "relay account not found" });
            return;
          }
          reply.code(200).send({ ...accountEnvelope(account), accountCredential });
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

  app.register(websocket);
  app.register(async (scope) => {
    scope.get("/v1/connect", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
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
            const origin =
              typeof request.headers.origin === "string" ? normalizeOrigin(request.headers.origin) : undefined;
            if (hello.role === "device" && origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
              reject(4403, "origin denied");
              return;
            }
            if (hello.role === "host") {
              if (!routeAccountIsActive(hello.routeId) || !store.authenticateHost(hello.routeId, hello.credential)) {
                reject(4401, "authentication failed");
                return;
              }
              const previous = hosts.get(hello.routeId);
              if (previous) closeHost(previous, 4409, "superseded host");
              liveHost = {
                socket,
                routeId: hello.routeId,
                devices: new Map(),
                rate: { startedAt: now(), bytes: 0, messages: 0 },
                closed: false,
              };
              hosts.set(hello.routeId, liveHost);
              metrics.activeHosts += 1;
              touchHost(liveHost);
              safeSend(socket, { t: "ready", role: "host", protocolVersion: 1 }, maxQueueBytes);
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
              const previous = host.devices.get(hello.deviceId);
              if (previous) closeDevice(previous, 4409, "superseded device");
              const channelId = safeId(generateChannelId(), "channel id");
              liveDevice = {
                socket,
                routeId: hello.routeId,
                deviceId: hello.deviceId,
                channelId,
                rate: { startedAt: now(), bytes: 0, messages: 0 },
                closed: false,
              };
              host.devices.set(hello.deviceId, liveDevice);
              devicesByChannel.set(channelId, liveDevice);
              metrics.activeDevices += 1;
              touchDevice(liveDevice);
              safeSend(socket, { t: "ready", role: "device", protocolVersion: 1, channelId }, maxQueueBytes);
              if (!safeSend(host.socket, { t: "peer-open", channelId, deviceId: hello.deviceId }, maxQueueBytes)) {
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
          const value = parseJson(raw, maxFrameBytes * 2);
          if (liveDevice) {
            touchDevice(liveDevice);
            if ((value as { t?: unknown })?.t === "ping") {
              safeSend(socket, { t: "pong", at: now() }, maxQueueBytes);
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
              safeSend(socket, { t: "pong", at: now() }, maxQueueBytes);
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
    if (ownsStore) store.close();
  });

  return {
    app,
    store,
    ...(accountStore ? { accountStore } : {}),
    metrics: () => ({ ...metrics, activeHosts: hosts.size, activeDevices: devicesByChannel.size }),
  };
}
