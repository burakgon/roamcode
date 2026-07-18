import { browserRelayConnectUrl } from "../relay/client";
import { browserRelayIdentityFingerprint } from "../relay/crypto";

const PENDING_KEY = "roamcode.managed-enrollment.pending.v1";
const MAX_PENDING_AGE_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface ManagedEnrollmentBootstrap {
  enrollmentId: string;
  challenge: string;
  relayUrl: string;
  routeId: string;
  temporaryDeviceId: string;
  hostIdentityPublicKey: string;
  hostIdentityFingerprint: string;
  hostLabel: string;
  expiresAt: number;
}

export interface ManagedEnrollmentAttempt {
  v: 1;
  hostId: string;
  idempotencyKey: string;
  temporaryDeviceId: string;
  temporaryRelayCredential: string;
  durableRelayCredential: string;
  deviceToken: string;
  createdAt: number;
  bootstrap?: ManagedEnrollmentBootstrap;
}

export class ManagedEnrollmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ManagedEnrollmentError";
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function randomCredential(prefix: "rrd" | "rcd"): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
  }
  return `${prefix}_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function uuid(): string {
  const value = globalThis.crypto.randomUUID();
  if (!UUID.test(value))
    throw new ManagedEnrollmentError("browser_crypto_unavailable", "Secure browser identity is unavailable.");
  return value;
}

function normalizedLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return label && label.length <= 80 && !UNSAFE_DISPLAY_TEXT.test(label) ? label : fallback;
}

function parseBootstrap(value: unknown, expectedDeviceId: string, now: number): ManagedEnrollmentBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedEnrollmentError("invalid_response", "RoamCode Cloud returned an invalid enrollment response.");
  }
  const body = value as Record<string, unknown>;
  const identity =
    body.host_identity && typeof body.host_identity === "object" && !Array.isArray(body.host_identity)
      ? (body.host_identity as Record<string, unknown>)
      : {};
  const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
  if (
    typeof body.enrollment_id !== "string" ||
    !UUID.test(body.enrollment_id) ||
    typeof body.challenge !== "string" ||
    !/^rce_[A-Za-z0-9_-]{43}$/.test(body.challenge) ||
    typeof body.relay_url !== "string" ||
    typeof body.route_id !== "string" ||
    !SAFE_ID.test(body.route_id) ||
    body.temporary_device_id !== expectedDeviceId ||
    typeof identity.public_key !== "string" ||
    !/^[A-Za-z0-9_-]{80,1024}$/.test(identity.public_key) ||
    typeof identity.fingerprint !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(identity.fingerprint) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_PENDING_AGE_MS
  ) {
    throw new ManagedEnrollmentError("invalid_response", "RoamCode Cloud returned an invalid enrollment response.");
  }
  let relayUrl: string;
  try {
    relayUrl = browserRelayConnectUrl(body.relay_url);
  } catch {
    throw new ManagedEnrollmentError("invalid_response", "RoamCode Cloud returned an untrusted relay address.");
  }
  return {
    enrollmentId: body.enrollment_id,
    challenge: body.challenge,
    relayUrl,
    routeId: body.route_id,
    temporaryDeviceId: expectedDeviceId,
    hostIdentityPublicKey: identity.public_key,
    hostIdentityFingerprint: identity.fingerprint,
    hostLabel: normalizedLabel(body.host_label, "RoamCode Node"),
    expiresAt,
  };
}

function parseStoredBootstrap(value: unknown, expectedDeviceId: string, now: number): ManagedEnrollmentBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedEnrollmentError("invalid_attempt", "This browser enrollment attempt is invalid.");
  }
  const bootstrap = value as Partial<ManagedEnrollmentBootstrap>;
  if (
    typeof bootstrap.enrollmentId !== "string" ||
    !UUID.test(bootstrap.enrollmentId) ||
    typeof bootstrap.challenge !== "string" ||
    !/^rce_[A-Za-z0-9_-]{43}$/.test(bootstrap.challenge) ||
    typeof bootstrap.relayUrl !== "string" ||
    typeof bootstrap.routeId !== "string" ||
    !SAFE_ID.test(bootstrap.routeId) ||
    bootstrap.temporaryDeviceId !== expectedDeviceId ||
    typeof bootstrap.hostIdentityPublicKey !== "string" ||
    !/^[A-Za-z0-9_-]{80,1024}$/.test(bootstrap.hostIdentityPublicKey) ||
    typeof bootstrap.hostIdentityFingerprint !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/.test(bootstrap.hostIdentityFingerprint) ||
    typeof bootstrap.hostLabel !== "string" ||
    normalizedLabel(bootstrap.hostLabel, "") !== bootstrap.hostLabel ||
    !Number.isSafeInteger(bootstrap.expiresAt) ||
    bootstrap.expiresAt! <= now ||
    bootstrap.expiresAt! > now + MAX_PENDING_AGE_MS
  ) {
    throw new ManagedEnrollmentError("invalid_attempt", "This browser enrollment attempt is invalid.");
  }
  let relayUrl: string;
  try {
    relayUrl = browserRelayConnectUrl(bootstrap.relayUrl);
  } catch {
    throw new ManagedEnrollmentError("invalid_attempt", "This browser enrollment attempt is invalid.");
  }
  return {
    enrollmentId: bootstrap.enrollmentId,
    challenge: bootstrap.challenge,
    relayUrl,
    routeId: bootstrap.routeId,
    temporaryDeviceId: expectedDeviceId,
    hostIdentityPublicKey: bootstrap.hostIdentityPublicKey,
    hostIdentityFingerprint: bootstrap.hostIdentityFingerprint,
    hostLabel: bootstrap.hostLabel,
    expiresAt: bootstrap.expiresAt!,
  };
}

function parseAttempt(value: unknown, now: number): ManagedEnrollmentAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedEnrollmentError("invalid_attempt", "This browser enrollment attempt is invalid.");
  }
  const attempt = value as Record<string, unknown>;
  if (
    attempt.v !== 1 ||
    typeof attempt.hostId !== "string" ||
    !UUID.test(attempt.hostId) ||
    typeof attempt.idempotencyKey !== "string" ||
    !UUID.test(attempt.idempotencyKey) ||
    typeof attempt.temporaryDeviceId !== "string" ||
    !UUID.test(attempt.temporaryDeviceId) ||
    typeof attempt.temporaryRelayCredential !== "string" ||
    !/^rrd_[A-Za-z0-9_-]{43}$/.test(attempt.temporaryRelayCredential) ||
    typeof attempt.durableRelayCredential !== "string" ||
    !/^rrd_[A-Za-z0-9_-]{43}$/.test(attempt.durableRelayCredential) ||
    attempt.durableRelayCredential === attempt.temporaryRelayCredential ||
    typeof attempt.deviceToken !== "string" ||
    !/^rcd_[A-Za-z0-9_-]{43}$/.test(attempt.deviceToken) ||
    !Number.isSafeInteger(attempt.createdAt) ||
    (attempt.createdAt as number) < now - MAX_PENDING_AGE_MS ||
    (attempt.createdAt as number) > now + 60_000
  ) {
    throw new ManagedEnrollmentError("invalid_attempt", "This browser enrollment attempt is invalid.");
  }
  const parsed: ManagedEnrollmentAttempt = {
    v: 1,
    hostId: attempt.hostId,
    idempotencyKey: attempt.idempotencyKey,
    temporaryDeviceId: attempt.temporaryDeviceId,
    temporaryRelayCredential: attempt.temporaryRelayCredential,
    durableRelayCredential: attempt.durableRelayCredential,
    deviceToken: attempt.deviceToken,
    createdAt: attempt.createdAt as number,
  };
  if (attempt.bootstrap !== undefined)
    parsed.bootstrap = parseStoredBootstrap(attempt.bootstrap, parsed.temporaryDeviceId, now);
  return parsed;
}

function persist(attempt: ManagedEnrollmentAttempt, storage: Storage | undefined): void {
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify(attempt));
  } catch {
    /* The in-memory attempt can still finish in this tab. */
  }
}

/**
 * Consume the non-secret Node selector immediately. A pending attempt is tab-scoped so a reload can
 * resume without placing any relay or local-device credential in history, logs, or durable storage.
 */
export function consumeOrResumeManagedEnrollment(
  now = Date.now(),
  storage: Storage | undefined = safeStorage(),
): ManagedEnrollmentAttempt | undefined {
  if (typeof window === "undefined") return undefined;
  const url = new URL(window.location.href);
  const selectedHostId = url.searchParams.get("enroll");
  if (selectedHostId !== null) {
    url.searchParams.delete("enroll");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (!UUID.test(selectedHostId)) {
      clearManagedEnrollment(storage);
      throw new ManagedEnrollmentError("invalid_host", "The selected Node is invalid.");
    }
    const attempt: ManagedEnrollmentAttempt = {
      v: 1,
      hostId: selectedHostId,
      idempotencyKey: uuid(),
      temporaryDeviceId: uuid(),
      temporaryRelayCredential: randomCredential("rrd"),
      durableRelayCredential: randomCredential("rrd"),
      deviceToken: randomCredential("rcd"),
      createdAt: now,
    };
    persist(attempt, storage);
    return attempt;
  }
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PENDING_KEY) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    return parseAttempt(JSON.parse(raw) as unknown, now);
  } catch {
    clearManagedEnrollment(storage);
    return undefined;
  }
}

export function managedEnrollmentIdentityKey(attempt: ManagedEnrollmentAttempt): string {
  return `managed:${attempt.hostId}:${attempt.temporaryDeviceId}`;
}

export function saveManagedEnrollment(
  attempt: ManagedEnrollmentAttempt,
  storage: Storage | undefined = safeStorage(),
  now = Date.now(),
): void {
  persist(parseAttempt(attempt, now), storage);
}

export function clearManagedEnrollment(storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.removeItem(PENDING_KEY);
  } catch {
    /* Best-effort cleanup in storage-restricted browsers. */
  }
}

export async function relayCredentialHash(credential: string): Promise<string> {
  if (!/^rrd_[A-Za-z0-9_-]{43}$/.test(credential))
    throw new ManagedEnrollmentError("invalid_attempt", "Invalid relay credential.");
  // This is the relay protocol's domain-separated credential digest, not a generic SHA-256. The control plane
  // forwards only this hash to the broker, so these exact bytes must stay aligned with relayCredentialHash().
  const material = new TextEncoder().encode(`roamcode-relay-credential-v1\0${credential}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha256:${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export async function createManagedBrowserEnrollment(
  attempt: ManagedEnrollmentAttempt,
  input: { label: string; publicKey: string; fingerprint: string },
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<ManagedEnrollmentBootstrap> {
  const current = parseAttempt(attempt, options.now ?? Date.now());
  const response = await (options.fetchImpl ?? fetch)(
    `/api/v1/hosts/${encodeURIComponent(current.hostId)}/browser-enrollments`,
    {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: current.idempotencyKey,
        label: normalizedLabel(input.label, "Browser"),
        device_fingerprint: input.fingerprint,
        public_key: input.publicKey,
        temporary_device_id: current.temporaryDeviceId,
        temporary_relay_credential_hash: await relayCredentialHash(current.temporaryRelayCredential),
      }),
    },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const code =
      typeof error.error === "string" ? error.error : typeof error.code === "string" ? error.code : "request_failed";
    const message =
      typeof error.error_description === "string"
        ? error.error_description
        : typeof error.message === "string"
          ? error.message
          : response.status === 401
            ? "Sign in to RoamCode before opening this Node."
            : "This browser could not be enrolled on the selected Node.";
    throw new ManagedEnrollmentError(code, message, response.status);
  }
  const bootstrap = parseBootstrap(body, current.temporaryDeviceId, options.now ?? Date.now());
  const actualHostFingerprint = await browserRelayIdentityFingerprint(bootstrap.hostIdentityPublicKey);
  if (actualHostFingerprint !== bootstrap.hostIdentityFingerprint) {
    throw new ManagedEnrollmentError(
      "host_identity_mismatch",
      "The Node identity returned by RoamCode Cloud is inconsistent.",
    );
  }
  return bootstrap;
}

export async function cancelManagedBrowserEnrollment(
  attempt: ManagedEnrollmentAttempt,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!attempt.bootstrap) return;
  const response = await fetchImpl(
    `/api/v1/hosts/${encodeURIComponent(attempt.hostId)}/browser-enrollments/${encodeURIComponent(attempt.bootstrap.enrollmentId)}`,
    { method: "DELETE", credentials: "include", headers: { accept: "application/json" } },
  );
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new ManagedEnrollmentError(
      "cancel_failed",
      "The pending Node enrollment could not be cancelled.",
      response.status,
    );
  }
}
