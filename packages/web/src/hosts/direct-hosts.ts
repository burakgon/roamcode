import type { AttentionItem } from "../types/server";

export type DirectHostConnectionState =
  | "checking"
  | "online"
  | "offline"
  | "certificate-error"
  | "revoked"
  | "protocol-mismatch"
  | "stale-version"
  | "clock-skew";

export interface DirectHostRecord {
  id: string;
  label: string;
  baseUrl: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Absent for legacy/direct entries. Relay routing metadata contains public material only. */
  relay?: RelayHostConnection;
}

export interface RelayHostConnection {
  relayUrl: string;
  routeId: string;
  deviceId: string;
  hostIdentityPublicKey: string;
  hostIdentityFingerprint: string;
  deviceIdentityFingerprint: string;
}

export interface DirectHostRegistry {
  version: 1;
  activeHostId: string;
  hosts: DirectHostRecord[];
}

export interface DirectHostSummary {
  hostId: string;
  state: DirectHostConnectionState;
  label?: string;
  serverVersion?: string;
  protocolVersion?: number;
  attentionCount: number;
  urgency: number;
  checkedAt: number;
  detail?: string;
}

export interface GlobalDirectAttentionItem extends AttentionItem {
  hostId: string;
  hostLabel: string;
  hostSortOrder: number;
}

export interface GlobalDirectSearchResult {
  hostId: string;
  hostLabel: string;
  hostSortOrder: number;
  kind: "host" | "workspace" | "session" | "agent" | "attention";
  id: string;
  label: string;
  detail?: string;
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  score: number;
  updatedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Routes one request through the transport owned by that host (direct HTTPS or encrypted relay). */
export type DirectHostRequest = (
  host: DirectHostRecord,
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const REGISTRY_KEY = "roamcode.direct-hosts.v1";
const TOKEN_PREFIX = "roamcode.direct-host-token.";
const RELAY_CREDENTIAL_PREFIX = "roamcode.relay-device-credential.";
const MAX_HOST_JSON_BYTES = 512 * 1024;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function store(storage?: StorageLike): StorageLike {
  return storage ?? window.localStorage;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function normalizeDirectHostUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Host URL cannot contain credentials, a query, or a fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Use HTTPS for a remote host; plain HTTP is allowed only on loopback.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Host URL must be an origin without a path.");
  }
  return url.origin;
}

function normalizeLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, " ");
  if (!label || label.length > 80 || UNSAFE_DISPLAY_TEXT.test(label)) {
    throw new Error("Host name must be 1-80 printable characters.");
  }
  return label;
}

function hostIdFor(baseUrl: string): string {
  return `host_${fnv1a(baseUrl)}`;
}

function relayConnectionKey(relay: RelayHostConnection): string {
  return `relay:${relay.relayUrl}:${relay.routeId}:${relay.deviceId}`;
}

function hostConnectionKey(host: DirectHostRecord): string {
  return host.relay ? relayConnectionKey(host.relay) : `direct:${host.baseUrl}`;
}

function normalizeRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Relay URL cannot contain credentials, a query, or a fragment.");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("Relay URL must use HTTPS or WSS.");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) throw new Error("Use TLS for a remote relay.");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/connect";
  else if (url.pathname.replace(/\/$/, "") !== "/v1/connect") throw new Error("Relay URL path must be /v1/connect.");
  return url.href;
}

function validRelay(value: unknown): value is RelayHostConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const relay = value as Partial<RelayHostConnection>;
  try {
    return (
      typeof relay.relayUrl === "string" &&
      normalizeRelayUrl(relay.relayUrl) === relay.relayUrl &&
      typeof relay.routeId === "string" &&
      /^[A-Za-z0-9._:-]{1,256}$/.test(relay.routeId) &&
      typeof relay.deviceId === "string" &&
      /^[A-Za-z0-9._:-]{1,256}$/.test(relay.deviceId) &&
      typeof relay.hostIdentityPublicKey === "string" &&
      /^[A-Za-z0-9_-]{80,1024}$/.test(relay.hostIdentityPublicKey) &&
      typeof relay.hostIdentityFingerprint === "string" &&
      /^sha256:[A-Za-z0-9_-]{43}$/.test(relay.hostIdentityFingerprint) &&
      typeof relay.deviceIdentityFingerprint === "string" &&
      /^sha256:[A-Za-z0-9_-]{43}$/.test(relay.deviceIdentityFingerprint)
    );
  } catch {
    return false;
  }
}

function availableHostId(hosts: readonly DirectHostRecord[], baseUrl: string): string {
  const base = hostIdFor(baseUrl);
  if (!hosts.some((host) => host.id === base)) return base;
  for (let suffix = 2; suffix <= hosts.length + 2; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!hosts.some((host) => host.id === candidate)) return candidate;
  }
  throw new Error("Could not allocate a unique host id.");
}

function ordered(hosts: DirectHostRecord[]): DirectHostRecord[] {
  return [...hosts]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((host, index) => ({ ...host, sortOrder: index }));
}

function validHost(value: unknown): value is DirectHostRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Partial<DirectHostRecord>;
  try {
    return (
      typeof host.id === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(host.id) &&
      typeof host.label === "string" &&
      normalizeLabel(host.label) === host.label &&
      typeof host.baseUrl === "string" &&
      normalizeDirectHostUrl(host.baseUrl) === host.baseUrl &&
      Number.isSafeInteger(host.sortOrder) &&
      typeof host.createdAt === "number" &&
      Number.isFinite(host.createdAt) &&
      typeof host.updatedAt === "number" &&
      Number.isFinite(host.updatedAt) &&
      (host.relay === undefined || validRelay(host.relay))
    );
  } catch {
    return false;
  }
}

export function saveDirectHostRegistry(registry: DirectHostRegistry, storage?: StorageLike): void {
  const hosts = ordered(registry.hosts);
  if (
    registry.version !== 1 ||
    hosts.length === 0 ||
    !hosts.every(validHost) ||
    new Set(hosts.map((host) => host.id)).size !== hosts.length ||
    new Set(hosts.map(hostConnectionKey)).size !== hosts.length ||
    !hosts.some((host) => host.id === registry.activeHostId)
  ) {
    throw new Error("Invalid direct host registry.");
  }
  store(storage).setItem(REGISTRY_KEY, JSON.stringify({ ...registry, hosts }));
}

export function loadDirectHostRegistry(
  currentOrigin: string,
  legacyToken?: string,
  storage?: StorageLike,
  activateCurrent = false,
  now = Date.now(),
): DirectHostRegistry {
  const target = normalizeDirectHostUrl(currentOrigin);
  let registry: DirectHostRegistry | undefined;
  try {
    const parsed = JSON.parse(store(storage).getItem(REGISTRY_KEY) ?? "null") as Partial<DirectHostRegistry> | null;
    if (
      parsed?.version === 1 &&
      typeof parsed.activeHostId === "string" &&
      Array.isArray(parsed.hosts) &&
      parsed.hosts.length > 0 &&
      parsed.hosts.every(validHost) &&
      new Set(parsed.hosts.map((host) => host.id)).size === parsed.hosts.length &&
      new Set(parsed.hosts.map(hostConnectionKey)).size === parsed.hosts.length &&
      parsed.hosts.some((host) => host.id === parsed.activeHostId)
    ) {
      registry = { version: 1, activeHostId: parsed.activeHostId, hosts: ordered(parsed.hosts) };
    }
  } catch {
    /* malformed local state is replaced with a safe current-origin entry */
  }
  const matching = registry?.hosts.find((host) => !host.relay && host.baseUrl === target);
  if (!registry) {
    const host: DirectHostRecord = {
      id: availableHostId([], target),
      label: new URL(target).hostname,
      baseUrl: target,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    };
    registry = { version: 1, activeHostId: host.id, hosts: [host] };
  } else if (!matching) {
    const host: DirectHostRecord = {
      id: availableHostId(registry.hosts, target),
      label: new URL(target).hostname,
      baseUrl: target,
      sortOrder: registry.hosts.length,
      createdAt: now,
      updatedAt: now,
    };
    registry = { ...registry, hosts: [...registry.hosts, host], ...(activateCurrent ? { activeHostId: host.id } : {}) };
  } else if (activateCurrent) {
    registry = { ...registry, activeHostId: matching.id };
  }
  if (legacyToken)
    saveDirectHostToken(
      registry.hosts.find((host) => !host.relay && host.baseUrl === target)!.id,
      legacyToken,
      storage,
    );
  saveDirectHostRegistry(registry, storage);
  return registry;
}

export function loadDirectHostToken(hostId: string, storage?: StorageLike): string | undefined {
  const token = store(storage).getItem(`${TOKEN_PREFIX}${hostId}`);
  return token !== null && validCredential(token) ? token : undefined;
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value.trim() === value && !/[\s\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

export function saveDirectHostToken(hostId: string, token: string, storage?: StorageLike): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(hostId)) throw new Error("Invalid host id");
  const normalized = token.trim();
  if (!validCredential(normalized)) throw new Error("Credential is invalid");
  store(storage).setItem(`${TOKEN_PREFIX}${hostId}`, normalized);
}

export function clearDirectHostToken(hostId: string, storage?: StorageLike): void {
  store(storage).removeItem(`${TOKEN_PREFIX}${hostId}`);
}

export function loadRelayHostCredential(hostId: string, storage?: StorageLike): string | undefined {
  const credential = store(storage).getItem(`${RELAY_CREDENTIAL_PREFIX}${hostId}`);
  return credential !== null && /^rrd_[A-Za-z0-9_-]{43}$/.test(credential) ? credential : undefined;
}

export function saveRelayHostCredential(hostId: string, credential: string, storage?: StorageLike): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(hostId)) throw new Error("Invalid host id");
  if (!/^rrd_[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("Relay credential is invalid");
  store(storage).setItem(`${RELAY_CREDENTIAL_PREFIX}${hostId}`, credential);
}

export function clearRelayHostCredential(hostId: string, storage?: StorageLike): void {
  store(storage).removeItem(`${RELAY_CREDENTIAL_PREFIX}${hostId}`);
}

export function addDirectHost(
  registry: DirectHostRegistry,
  input: { label: string; baseUrl: string; token: string },
  storage?: StorageLike,
  now = Date.now(),
): DirectHostRegistry {
  const baseUrl = normalizeDirectHostUrl(input.baseUrl);
  const label = normalizeLabel(input.label);
  if (registry.hosts.some((host) => !host.relay && host.baseUrl === baseUrl)) {
    throw new Error("That host is already in the list.");
  }
  const id = availableHostId(registry.hosts, baseUrl);
  saveDirectHostToken(id, input.token, storage);
  const host: DirectHostRecord = {
    id,
    label,
    baseUrl,
    sortOrder: registry.hosts.length,
    createdAt: now,
    updatedAt: now,
  };
  const next = { version: 1 as const, activeHostId: id, hosts: [...registry.hosts, host] };
  saveDirectHostRegistry(next, storage);
  return next;
}

export function addRelayHost(
  registry: DirectHostRegistry,
  input: {
    label: string;
    appBaseUrl: string;
    token: string;
    deviceCredential: string;
    relay: RelayHostConnection;
  },
  storage?: StorageLike,
  now = Date.now(),
): DirectHostRegistry {
  const label = normalizeLabel(input.label);
  const relay: RelayHostConnection = { ...input.relay, relayUrl: normalizeRelayUrl(input.relay.relayUrl) };
  if (!validRelay(relay)) throw new Error("Relay connection metadata is invalid.");
  const key = relayConnectionKey(relay);
  if (registry.hosts.some((host) => hostConnectionKey(host) === key))
    throw new Error("That relay host is already listed.");
  const id = availableHostId(registry.hosts, key);
  saveDirectHostToken(id, input.token, storage);
  saveRelayHostCredential(id, input.deviceCredential, storage);
  const host: DirectHostRecord = {
    id,
    label,
    baseUrl: normalizeDirectHostUrl(input.appBaseUrl),
    sortOrder: registry.hosts.length,
    createdAt: now,
    updatedAt: now,
    relay,
  };
  const next = { version: 1 as const, activeHostId: id, hosts: [...registry.hosts, host] };
  saveDirectHostRegistry(next, storage);
  return next;
}

export function updateDirectHost(
  registry: DirectHostRegistry,
  id: string,
  input: { label?: string; sortOrder?: number },
  storage?: StorageLike,
  now = Date.now(),
): DirectHostRegistry {
  const index = registry.hosts.findIndex((host) => host.id === id);
  if (index < 0) throw new Error("Host not found.");
  const host = registry.hosts[index]!;
  const nextHost = {
    ...host,
    ...(input.label === undefined ? {} : { label: normalizeLabel(input.label) }),
    updatedAt: now,
  };
  const hosts = [...registry.hosts];
  hosts[index] = nextHost;
  if (input.sortOrder !== undefined) {
    if (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder >= hosts.length) {
      throw new Error("Invalid host order.");
    }
    hosts.splice(index, 1);
    hosts.splice(input.sortOrder, 0, nextHost);
    for (let order = 0; order < hosts.length; order += 1) hosts[order] = { ...hosts[order]!, sortOrder: order };
  }
  const next = { ...registry, hosts: ordered(hosts) };
  saveDirectHostRegistry(next, storage);
  return next;
}

export function activateDirectHost(
  registry: DirectHostRegistry,
  id: string,
  storage?: StorageLike,
): DirectHostRegistry {
  if (!registry.hosts.some((host) => host.id === id)) throw new Error("Host not found.");
  const next = { ...registry, activeHostId: id };
  saveDirectHostRegistry(next, storage);
  return next;
}

export function removeDirectHost(registry: DirectHostRegistry, id: string, storage?: StorageLike): DirectHostRegistry {
  if (registry.hosts.length <= 1) throw new Error("Keep at least one host.");
  const index = registry.hosts.findIndex((host) => host.id === id);
  if (index < 0) throw new Error("Host not found.");
  clearDirectHostToken(id, storage);
  clearRelayHostCredential(id, storage);
  const hosts = ordered(registry.hosts.filter((host) => host.id !== id));
  const activeHostId =
    registry.activeHostId === id ? hosts[Math.min(index, hosts.length - 1)]!.id : registry.activeHostId;
  const next = { ...registry, activeHostId, hosts };
  saveDirectHostRegistry(next, storage);
  return next;
}

function connectionFailure(error: unknown): Pick<DirectHostSummary, "state" | "detail"> {
  const message = error instanceof Error ? error.message : "";
  if (/certificate|ssl|tls|cert_/i.test(message)) {
    return { state: "certificate-error", detail: "Open the host once and trust or repair its HTTPS certificate." };
  }
  return { state: "offline", detail: "Host is unreachable. Check its URL, service, tunnel, and network." };
}

function semver(value: string | undefined): [number, number, number] | undefined {
  const match = value?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function boundedJson<T>(response: Response): Promise<T> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_HOST_JSON_BYTES) throw new Error("host response is too large");
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_HOST_JSON_BYTES) throw new Error("host response is too large");
  return JSON.parse(body) as T;
}

function finiteNumber(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function validAttentionItem(value: unknown): value is AttentionItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AttentionItem>;
  const kinds = new Set(["blocked", "done", "error", "file", "policy"]);
  const states = new Set(["open", "acknowledged", "snoozed", "resolved"]);
  return (
    boundedString(item.id, 256) &&
    boundedString(item.workspaceId, 256) &&
    boundedString(item.sessionId, 256) &&
    boundedString(item.agentId, 256) &&
    typeof item.kind === "string" &&
    kinds.has(item.kind) &&
    typeof item.state === "string" &&
    states.has(item.state) &&
    boundedString(item.title, 500) &&
    (item.detail === undefined || (typeof item.detail === "string" && item.detail.length <= 4_096)) &&
    finiteNumber(item.urgency) &&
    Number.isSafeInteger(item.occurrenceCount) &&
    (item.occurrenceCount ?? 0) >= 1 &&
    finiteNumber(item.createdAt) &&
    finiteNumber(item.updatedAt)
  );
}

function validSearchResult(
  value: unknown,
): value is Omit<GlobalDirectSearchResult, "hostId" | "hostLabel" | "hostSortOrder"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<GlobalDirectSearchResult>;
  const kinds = new Set(["host", "workspace", "session", "agent", "attention"]);
  const optionalId = (candidate: unknown) => candidate === undefined || boundedString(candidate, 256);
  return (
    typeof result.kind === "string" &&
    kinds.has(result.kind) &&
    boundedString(result.id, 256) &&
    boundedString(result.label, 500) &&
    (result.detail === undefined || (typeof result.detail === "string" && result.detail.length <= 4_096)) &&
    optionalId(result.workspaceId) &&
    optionalId(result.sessionId) &&
    optionalId(result.agentId) &&
    finiteNumber(result.score) &&
    finiteNumber(result.updatedAt)
  );
}

export async function inspectDirectHost(
  host: DirectHostRecord,
  token: string | undefined,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  now = Date.now(),
  clientVersion?: string,
  requestHost: DirectHostRequest = (_host, input, init) => fetchFn(input, init),
): Promise<DirectHostSummary> {
  if (!token) {
    return {
      hostId: host.id,
      state: "revoked",
      attentionCount: 0,
      urgency: 0,
      checkedAt: now,
      detail: "Sign in or pair this host.",
    };
  }
  try {
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    const [capabilities, attention] = await Promise.all([
      requestHost(host, `${host.baseUrl}/api/v1/capabilities`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      }),
      requestHost(host, `${host.baseUrl}/api/v1/attention`, { headers, signal: AbortSignal.timeout(8_000) }),
    ]);
    if (capabilities.status === 401 || attention.status === 401) {
      return {
        hostId: host.id,
        state: "revoked",
        attentionCount: 0,
        urgency: 0,
        checkedAt: now,
        detail: "Credential was revoked. Pair again.",
      };
    }
    if (!capabilities.ok || !attention.ok) throw new Error(`host returned ${capabilities.status}/${attention.status}`);
    const capabilityBody = await boundedJson<{
      protocolVersion?: unknown;
      serverVersion?: unknown;
      serverTime?: unknown;
      host?: { label?: unknown };
    }>(capabilities);
    const attentionBody = await boundedJson<{
      items?: Array<{ urgency?: unknown; state?: unknown }>;
      unreadCount?: unknown;
    }>(attention);
    if (capabilityBody.protocolVersion !== 1) {
      return {
        hostId: host.id,
        state: "protocol-mismatch",
        protocolVersion:
          typeof capabilityBody.protocolVersion === "number" ? capabilityBody.protocolVersion : undefined,
        attentionCount: 0,
        urgency: 0,
        checkedAt: now,
        detail: "This app and host use incompatible command protocols. Update the older side.",
      };
    }
    const items = Array.isArray(attentionBody.items) ? attentionBody.items.slice(0, 10_000) : [];
    const baseSummary = {
      hostId: host.id,
      ...(typeof capabilityBody.host?.label === "string" ? { label: capabilityBody.host.label } : {}),
      ...(typeof capabilityBody.serverVersion === "string" ? { serverVersion: capabilityBody.serverVersion } : {}),
      protocolVersion: 1,
      attentionCount:
        typeof attentionBody.unreadCount === "number" &&
        Number.isSafeInteger(attentionBody.unreadCount) &&
        attentionBody.unreadCount >= 0 &&
        attentionBody.unreadCount <= 100_000
          ? attentionBody.unreadCount
          : items.filter((item) => item.state === "open").length,
      urgency: items.reduce(
        (max, item) =>
          typeof item.urgency === "number" && Number.isFinite(item.urgency) ? Math.max(max, item.urgency) : max,
        0,
      ),
      checkedAt: now,
    };
    if (typeof capabilityBody.serverTime === "number" && Math.abs(capabilityBody.serverTime - now) > 5 * 60_000) {
      return {
        ...baseSummary,
        state: "clock-skew",
        detail: "Host clock differs by more than five minutes. Correct NTP/time settings before pairing or relay use.",
      };
    }
    const client = semver(clientVersion);
    const server = semver(typeof capabilityBody.serverVersion === "string" ? capabilityBody.serverVersion : undefined);
    if (client && server && compareVersion(server, client) !== 0) {
      const hostOlder = compareVersion(server, client) < 0;
      return {
        ...baseSummary,
        state: "stale-version",
        detail: hostOlder
          ? "This host is older than the command center. Update the host."
          : "This app is older than the host. Refresh or update the app.",
      };
    }
    return {
      ...baseSummary,
      state: "online",
    };
  } catch (error) {
    return { hostId: host.id, ...connectionFailure(error), attentionCount: 0, urgency: 0, checkedAt: now };
  }
}

async function authenticatedHostJson<T>(
  host: DirectHostRecord,
  path: string,
  storage: StorageLike | undefined,
  requestHost: DirectHostRequest,
): Promise<T> {
  const token = loadDirectHostToken(host.id, storage);
  if (!token) throw new Error("credential revoked");
  const response = await requestHost(host, `${host.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401) throw new Error("credential revoked");
  if (!response.ok) throw new Error(`host returned ${response.status}`);
  return boundedJson<T>(response);
}

export async function listGlobalDirectAttention(
  registry: DirectHostRegistry,
  storage?: StorageLike,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  requestHost: DirectHostRequest = (_host, input, init) => fetchFn(input, init),
): Promise<GlobalDirectAttentionItem[]> {
  const batches = await Promise.all(
    registry.hosts.map(async (host) => {
      try {
        const body = await authenticatedHostJson<{ items?: AttentionItem[] }>(
          host,
          "/api/v1/attention",
          storage,
          requestHost,
        );
        return (Array.isArray(body.items) ? body.items : [])
          .filter(validAttentionItem)
          .slice(0, 10_000)
          .map((item) => ({
            ...item,
            hostId: host.id,
            hostLabel: host.label,
            hostSortOrder: host.sortOrder,
          }));
      } catch {
        return [];
      }
    }),
  );
  return batches
    .flat()
    .sort(
      (a, b) =>
        b.urgency - a.urgency ||
        b.updatedAt - a.updatedAt ||
        a.hostSortOrder - b.hostSortOrder ||
        a.hostId.localeCompare(b.hostId) ||
        a.id.localeCompare(b.id),
    );
}

export async function searchDirectHosts(
  registry: DirectHostRegistry,
  query: string,
  storage?: StorageLike,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  requestHost: DirectHostRequest = (_host, input, init) => fetchFn(input, init),
): Promise<GlobalDirectSearchResult[]> {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 100) return [];
  const batches = await Promise.all(
    registry.hosts.map(async (host) => {
      try {
        const params = new URLSearchParams({ q: normalized, limit: "50" });
        const body = await authenticatedHostJson<{
          results?: Array<Omit<GlobalDirectSearchResult, "hostId" | "hostLabel" | "hostSortOrder">>;
        }>(host, `/api/v1/search?${params.toString()}`, storage, requestHost);
        return (Array.isArray(body.results) ? body.results : []).filter(validSearchResult).map((result) => ({
          ...result,
          hostId: host.id,
          hostLabel: host.label,
          hostSortOrder: host.sortOrder,
        }));
      } catch {
        return [];
      }
    }),
  );
  return batches
    .flat()
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.updatedAt - a.updatedAt ||
        a.hostSortOrder - b.hostSortOrder ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 100);
}

export function sortGlobalAttentionHosts(registry: DirectHostRegistry, summaries: Record<string, DirectHostSummary>) {
  return registry.hosts
    .map((host) => ({ host, summary: summaries[host.id] }))
    .sort(
      (a, b) =>
        (b.summary?.urgency ?? 0) - (a.summary?.urgency ?? 0) ||
        (b.summary?.attentionCount ?? 0) - (a.summary?.attentionCount ?? 0) ||
        a.host.sortOrder - b.host.sortOrder ||
        a.host.id.localeCompare(b.host.id),
    );
}
