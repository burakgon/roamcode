import type { CloudAuthorizationStore, CloudAuthorizationState } from "./cloud-authorization-store.js";
import {
  CloudAuthorizationVerificationError,
  CloudHostHeartbeatV1Schema,
  CloudRelayHostIdentitySchema,
  type CloudHostHeartbeatV1,
  type CloudRelayHostIdentity,
} from "./cloud-contract.js";
import { CloudHostConfigSchema, type CloudHostConfig } from "./cloud-host-config.js";
import {
  CLOUD_AUTHORIZATION_KEYSET_PATH,
  CloudKeysetVerificationError,
  SignedCloudAuthorizationKeysetSchema,
  verifySignedCloudAuthorizationKeyset,
  type CloudAuthorizationKeyset,
} from "./cloud-keyset.js";

export const CLOUD_HOST_HEARTBEAT_PATH = "/api/v1/hosts/heartbeat";
export const CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH = "/api/v1/hosts/authorization-snapshot";
export const CLOUD_HOST_MAX_SIGNED_RESPONSE_BYTES = 16 * 1024 * 1024;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_RETRY_MS = 1_000;

export interface CloudHostRuntimeStatus {
  running: boolean;
  heartbeatFailures: number;
  authorizationFailures: number;
  authorizationIssue?: CloudHostAuthorizationIssue;
  lastHeartbeatAt?: number;
  lastAuthorizationAt?: number;
  authorization: CloudAuthorizationState;
}

export type CloudHostAuthorizationIssue =
  | "connectivity"
  | "credential-rejected"
  | "invalid-control-plane-response"
  | "authorization-verification-failed"
  | "trust-expired";

export interface CloudHostRuntime {
  start(): void;
  stop(): Promise<void>;
  sendHeartbeat(state?: "ready" | "draining"): Promise<void>;
  refreshAuthorizationKeyset(): Promise<boolean>;
  refreshAuthorizationSnapshot(): Promise<number>;
  syncAuthorization(): Promise<number>;
  /** Waits out an older in-flight poll, then starts a snapshot request from the resulting durable revision. */
  syncAuthorizationFresh(): Promise<number>;
  status(): CloudHostRuntimeStatus;
}

export interface CreateCloudHostRuntimeOptions {
  config: CloudHostConfig;
  authorizationStore: CloudAuthorizationStore;
  instanceId: string;
  softwareVersion: string;
  capabilities: readonly string[] | (() => readonly string[]);
  /** Stable P-256 host identity advertised for browser enrollment pinning; private key never leaves this Node. */
  relayHostIdentity?: CloudRelayHostIdentity;
  /** Called only after a signed rotation verifies against the currently pinned keyset. Must persist atomically. */
  replaceAuthorizationKeyset: (keyset: CloudAuthorizationKeyset) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  requestTimeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export type CloudHostRuntimeErrorCode = "UNAVAILABLE" | "REJECTED" | "INVALID_RESPONSE" | "KEYSET_REPLAY";

export class CloudHostRuntimeError extends Error {
  constructor(
    readonly code: CloudHostRuntimeErrorCode,
    readonly retryable: boolean,
  ) {
    super(
      code === "REJECTED"
        ? "cloud host credential was rejected"
        : code === "INVALID_RESPONSE"
          ? "cloud host control plane returned an invalid response"
          : code === "KEYSET_REPLAY"
            ? "cloud authorization keyset did not advance monotonically"
            : "cloud host control plane is temporarily unavailable",
    );
    this.name = "CloudHostRuntimeError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CLOUD_HOST_MAX_SIGNED_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudHostRuntimeError("INVALID_RESPONSE", false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > CLOUD_HOST_MAX_SIGNED_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudHostRuntimeError("INVALID_RESPONSE", false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function responseError(response: Response): CloudHostRuntimeError {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new CloudHostRuntimeError(retryable ? "UNAVAILABLE" : "REJECTED", retryable);
}

function authorizationIssue(error: unknown): CloudHostAuthorizationIssue {
  if (error instanceof CloudHostRuntimeError) {
    if (error.code === "UNAVAILABLE") return "connectivity";
    if (error.code === "REJECTED") return "credential-rejected";
    if (error.code === "INVALID_RESPONSE") return "invalid-control-plane-response";
  }
  if (
    (error instanceof CloudAuthorizationVerificationError && error.code === "TRUST_EXPIRED") ||
    (error instanceof CloudKeysetVerificationError && error.code === "PIN_EXPIRED")
  ) {
    return "trust-expired";
  }
  return "authorization-verification-failed";
}

export function createCloudHostRuntime(options: CreateCloudHostRuntimeOptions): CloudHostRuntime {
  // Parse and clone once. Neither a caller mutation nor a browser payload can change the credential destination
  // after this boundary has been constructed.
  const config = CloudHostConfigSchema.parse(options.config);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60_000) {
    throw new Error("cloud host request timeout is invalid");
  }
  const heartbeatIntervalMs = config.heartbeatIntervalSeconds * 1_000;
  const authorizationIntervalMs = config.authorizationRefreshIntervalSeconds * 1_000;
  const relayHostIdentity =
    options.relayHostIdentity === undefined ? undefined : CloudRelayHostIdentitySchema.parse(options.relayHostIdentity);
  let pinnedKeyset = clone(config.authorization.keyset);
  let sequence = 0;
  let lastHeartbeatSentAt = -1;
  let lastHeartbeatAt: number | undefined;
  let lastAuthorizationAt: number | undefined;
  let heartbeatFailures = 0;
  let authorizationFailures = 0;
  let lastAuthorizationIssue: CloudHostAuthorizationIssue | undefined;
  let running = false;
  let stopping = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let authorizationInFlight: Promise<number> | undefined;

  const capabilities = (): string[] =>
    [...new Set(typeof options.capabilities === "function" ? options.capabilities() : options.capabilities)].sort();

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(`${config.controlPlaneOrigin}${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof CloudHostRuntimeError) throw error;
      throw new CloudHostRuntimeError("UNAVAILABLE", true);
    }
  };

  const authenticatedHeaders = (extra: Record<string, string> = {}) => ({
    ...extra,
    authorization: `Bearer ${config.hostCredential}`,
  });

  const refreshAuthorizationKeyset = async (): Promise<boolean> => {
    const response = await request(CLOUD_AUTHORIZATION_KEYSET_PATH, {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) {
      await boundedResponseText(response).catch(() => "");
      throw responseError(response);
    }
    let value: unknown;
    try {
      value = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (error instanceof CloudHostRuntimeError) throw error;
      throw new CloudHostRuntimeError("INVALID_RESPONSE", false);
    }
    const parsed = SignedCloudAuthorizationKeysetSchema.safeParse(value);
    if (!parsed.success) throw new CloudHostRuntimeError("INVALID_RESPONSE", false);
    const verified = verifySignedCloudAuthorizationKeyset(parsed.data, pinnedKeyset, now());
    const next = verified.keyset;
    if (next.issuedAt < pinnedKeyset.issuedAt) throw new CloudHostRuntimeError("KEYSET_REPLAY", false);
    if (next.issuedAt === pinnedKeyset.issuedAt) {
      if (JSON.stringify(next) !== JSON.stringify(pinnedKeyset)) {
        throw new CloudHostRuntimeError("KEYSET_REPLAY", false);
      }
      return false;
    }
    options.replaceAuthorizationKeyset(clone(next));
    pinnedKeyset = clone(next);
    return true;
  };

  const refreshAuthorizationSnapshot = async (): Promise<number> => {
    const revision = options.authorizationStore.getState(now()).revision;
    const path = `${CLOUD_HOST_AUTHORIZATION_SNAPSHOT_PATH}${
      revision === undefined ? "" : `?after_revision=${encodeURIComponent(revision)}`
    }`;
    const response = await request(path, {
      method: "GET",
      cache: "no-store",
      headers: authenticatedHeaders({ accept: "application/json" }),
    });
    if (response.status !== 200) {
      await boundedResponseText(response).catch(() => "");
      throw responseError(response);
    }
    let value: unknown;
    try {
      value = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (error instanceof CloudHostRuntimeError) throw error;
      throw new CloudHostRuntimeError("INVALID_RESPONSE", false);
    }
    return options.authorizationStore.apply(value, now()).snapshot.revision;
  };

  const performAuthorizationSync = async (): Promise<number> => {
    // Key rotation is independent from snapshot availability. A stale or temporarily unavailable keyset endpoint
    // must not prevent renewal under an existing valid pin; a newly rotated signing key will still fail closed until
    // a cross-signed keyset verifies and is durably installed.
    await refreshAuthorizationKeyset().catch(() => false);
    const revision = await refreshAuthorizationSnapshot();
    lastAuthorizationAt = now();
    return revision;
  };

  const syncAuthorization = (): Promise<number> => {
    if (authorizationInFlight) return authorizationInFlight;
    const operation = performAuthorizationSync().finally(() => {
      if (authorizationInFlight === operation) authorizationInFlight = undefined;
    });
    authorizationInFlight = operation;
    return operation;
  };

  const syncAuthorizationFresh = (): Promise<number> => {
    const preceding = authorizationInFlight;
    if (!preceding) return syncAuthorization();
    // Enrollment confirmation can race the normal background poll. Waiting for that older request and then
    // entering through the coalescing boundary guarantees at least one request began after confirmation.
    return preceding.then(syncAuthorization, syncAuthorization);
  };

  const sendHeartbeat = async (state: "ready" | "draining" = "ready"): Promise<void> => {
    const currentNow = now();
    const sentAt = Math.max(currentNow, lastHeartbeatSentAt + 1);
    lastHeartbeatSentAt = sentAt;
    sequence += 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("cloud heartbeat sequence exhausted");
    const heartbeat: CloudHostHeartbeatV1 = CloudHostHeartbeatV1Schema.parse({
      v: 1,
      kind: "host-heartbeat",
      organizationId: config.organizationId,
      hostId: config.hostId,
      instanceId: options.instanceId,
      sentAt,
      sequence,
      softwareVersion: options.softwareVersion,
      state,
      authorizationRevision: options.authorizationStore.getState(currentNow).revision ?? null,
      ...(relayHostIdentity ? { relayHostIdentity } : {}),
      capabilities: capabilities(),
    });
    const response = await request(CLOUD_HOST_HEARTBEAT_PATH, {
      method: "POST",
      headers: authenticatedHeaders({ "content-type": "application/json", accept: "application/json" }),
      body: JSON.stringify(heartbeat),
    });
    if (response.status !== 204) {
      await boundedResponseText(response).catch(() => "");
      throw responseError(response);
    }
    await response.body?.cancel().catch(() => undefined);
    lastHeartbeatAt = currentNow;
  };

  const jittered = (baseMs: number): number => {
    const sample = random();
    const unit = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
    return Math.max(250, Math.round(baseMs * (0.9 + unit * 0.2)));
  };
  const nextDelay = (intervalMs: number, failures: number): number =>
    jittered(failures === 0 ? intervalMs : Math.min(intervalMs, MIN_RETRY_MS * 2 ** Math.min(10, failures - 1)));

  const scheduleHeartbeat = (delay: number) => {
    if (!running || stopping) return;
    heartbeatTimer = setTimer(() => {
      if (!running || stopping) return;
      heartbeatInFlight = sendHeartbeat("ready")
        .then(() => {
          heartbeatFailures = 0;
        })
        .catch(() => {
          heartbeatFailures += 1;
        })
        .finally(() => {
          heartbeatInFlight = undefined;
          scheduleHeartbeat(nextDelay(heartbeatIntervalMs, heartbeatFailures));
        });
    }, delay);
    heartbeatTimer.unref?.();
  };

  const scheduleAuthorization = (delay: number) => {
    if (!running || stopping) return;
    authorizationTimer = setTimer(() => {
      if (!running || stopping) return;
      void syncAuthorization()
        .then(() => {
          authorizationFailures = 0;
          lastAuthorizationIssue = undefined;
        })
        .catch((error: unknown) => {
          authorizationFailures += 1;
          lastAuthorizationIssue = authorizationIssue(error);
        })
        .finally(() => {
          scheduleAuthorization(nextDelay(authorizationIntervalMs, authorizationFailures));
        });
    }, delay);
    authorizationTimer.unref?.();
  };

  return {
    start() {
      if (running) return;
      running = true;
      stopping = false;
      scheduleHeartbeat(0);
      scheduleAuthorization(0);
    },
    async stop() {
      if (!running && !stopping) return;
      stopping = true;
      running = false;
      if (heartbeatTimer) clearTimer(heartbeatTimer);
      if (authorizationTimer) clearTimer(authorizationTimer);
      await Promise.allSettled([heartbeatInFlight, authorizationInFlight].filter(Boolean));
      await sendHeartbeat("draining").catch(() => undefined);
      stopping = false;
    },
    sendHeartbeat,
    refreshAuthorizationKeyset,
    refreshAuthorizationSnapshot,
    syncAuthorization,
    syncAuthorizationFresh,
    status: () => ({
      running,
      heartbeatFailures,
      authorizationFailures,
      ...(lastAuthorizationIssue ? { authorizationIssue: lastAuthorizationIssue } : {}),
      ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
      ...(lastAuthorizationAt === undefined ? {} : { lastAuthorizationAt }),
      authorization: options.authorizationStore.getState(now()),
    }),
  };
}
