import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { relayIdentityFingerprint } from "./relay-crypto.js";

const require = createRequire(import.meta.url);

/** A pairing link is deliberately short-lived and can be claimed exactly once. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export type DeviceScope = "direct" | "relay";

/** Avoid turning normal API polling into a SQLite write on every request. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
const CLOUD_ENROLLMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLOUD_PREPARED_ENROLLMENT_RETENTION_MS = 30 * 60 * 1000;
const CLOUD_ENROLLMENT_PRUNE_BATCH = 100;
const UNSAFE_DISPLAY_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_CHALLENGE = /^rce_[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN = /^rcd_[A-Za-z0-9_-]{43}$/;
const RELAY_CREDENTIAL_HASH = /^sha256:[A-Za-z0-9_-]{43}$/;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  scopes: DeviceScope[];
  /** Pinned E2E relay signing identity. Public material only; the private key never leaves the device. */
  relayIdentityFingerprint?: string;
}

export interface DeviceRelayIdentity {
  publicKey: string;
  fingerprint: string;
}

export class DevicePairingError extends Error {
  constructor(
    readonly code: "INVALID_RELAY_IDENTITY",
    message: string,
  ) {
    super(message);
    this.name = "DevicePairingError";
  }
}

export interface PairingTicket {
  /** One-time capability carried by the pairing URL. Never persisted in plaintext. */
  secret: string;
  expiresAt: number;
  /** Exact product surfaces the resulting device credential can reach. */
  scopes: DeviceScope[];
}

/**
 * Relay bootstrap pre-allocates both durable ids. The token is still inert until the one-use pairing
 * capability is claimed, but carrying it in the URL fragment makes a dropped final response recoverable:
 * the browser can reconnect with the same credential after the host committed the claim.
 */
export interface RelayPairingTicket extends PairingTicket {
  deviceId: string;
  token: string;
}

export interface RelayPairingCancellationReservation {
  deviceId: string;
  reservationId: string;
}

export type RelayPairingCancellationStart =
  { status: "reserved"; reservation: RelayPairingCancellationReservation } | { status: "busy" } | { status: "missing" };

export interface DeviceEnrollment {
  /** The per-device bearer credential. Returned once; only its SHA-256 digest is persisted. */
  token: string;
  device: DeviceInfo;
}

export type CloudDeviceEnrollmentState =
  "prepared" | "local-finalized" | "cloud-report-pending" | "complete" | "revoked";
type PersistedCloudDeviceEnrollmentState = "prepared" | "local-finalized" | "complete";

export interface CloudDeviceEnrollmentPrepareInput {
  enrollmentId: string;
  deviceId: string;
  challenge: string;
  name: string;
  token: string;
  relayIdentityPublicKey: string;
  durableRelayCredentialHash: string;
}

export interface CloudDeviceEnrollmentProgress {
  enrollmentId: string;
  deviceId: string;
  state: CloudDeviceEnrollmentState;
  durableRelayCredentialHash: string;
  temporaryRelayCredentialHash?: string;
  controlPlaneDeviceId?: string;
  device?: DeviceInfo;
}

export interface PendingCloudDevicePromotion {
  enrollmentId: string;
  deviceId: string;
  expectedCredentialHash: string;
  credentialHash: string;
  controlPlaneDeviceId: string;
  brokerPromoted: boolean;
}

export class CloudDeviceEnrollmentConflictError extends Error {
  constructor() {
    super("cloud device enrollment conflicts with existing local state");
    this.name = "CloudDeviceEnrollmentConflictError";
  }
}

export interface DeviceStore {
  readonly mode: "sqlite" | "memory-fallback";
  issuePairing(now?: number, scopes?: DeviceScope[]): PairingTicket;
  cancelPairing(secret: string): boolean;
  claimPairing(
    secret: string,
    name: string,
    now?: number,
    relayIdentityPublicKey?: string,
  ): DeviceEnrollment | undefined;
  issueRelayPairing(now?: number): RelayPairingTicket;
  pendingRelayPairing(deviceId: string, now?: number): boolean;
  /** Atomically prevents a relay claim from winning while broker revocation is in flight. */
  beginRelayPairingCancellation(deviceId: string, now?: number): RelayPairingCancellationStart;
  /** Release a failed broker-revocation attempt so the same expiry-bounded link can be retried. */
  releaseRelayPairingCancellation(reservation: RelayPairingCancellationReservation): boolean;
  /** Delete the local bootstrap only after broker revocation is authoritative. */
  finishRelayPairingCancellation(reservation: RelayPairingCancellationReservation): boolean;
  cancelRelayPairing(deviceId: string): boolean;
  claimRelayPairing(
    secret: string,
    token: string,
    name: string,
    relayIdentityPublicKey: string,
    now?: number,
  ): DeviceEnrollment | undefined;
  /** Resolve a per-device bearer credential and best-effort touch its last-seen time. */
  authenticate(token: string, now?: number, requiredScope?: DeviceScope): DeviceInfo | undefined;
  relayIdentity(id: string): DeviceRelayIdentity | undefined;
  /** Persist only digests before contacting the control plane; exact replays resume the same saga. */
  beginCloudDeviceEnrollment(input: CloudDeviceEnrollmentPrepareInput, now?: number): CloudDeviceEnrollmentProgress;
  /** Atomically inserts the canonical relay actor and advances the saga after control-plane confirmation. */
  finalizeCloudDeviceEnrollment(
    enrollmentId: string,
    temporaryRelayCredentialHash: string,
    controlPlaneDeviceId: string,
    now?: number,
  ): CloudDeviceEnrollmentProgress;
  /** Persist the successful broker CAS before the control-plane completion report is attempted. */
  markCloudDeviceEnrollmentPromoted(
    enrollmentId: string,
    expectedCredentialHash: string,
    credentialHash: string,
    now?: number,
  ): CloudDeviceEnrollmentProgress;
  /** Marks activation durable only after the broker CAS and control-plane report both commit. */
  completeCloudDeviceEnrollment(
    enrollmentId: string,
    expectedCredentialHash: string,
    credentialHash: string,
    now?: number,
  ): CloudDeviceEnrollmentProgress;
  /** Tombstone a control-plane-revoked enrollment and remove its still-inert local actor. */
  revokeCloudDeviceEnrollment(
    enrollmentId: string,
    controlPlaneDeviceId: string,
    expectedCredentialHash: string,
    credentialHash: string,
    now?: number,
  ): CloudDeviceEnrollmentProgress;
  /** Pending local actors must not normal-auth until broker promotion and a fresh cloud grant both commit. */
  cloudDeviceEnrollmentPending(deviceId: string): boolean;
  /** Return a bounded, oldest-attempted-first recovery page without materializing the full queue. */
  pendingCloudDevicePromotions(now?: number, limit?: number): PendingCloudDevicePromotion[];
  /** Move an exact still-pending promotion behind other queued work after a failed recovery attempt. */
  deferCloudDevicePromotion(
    enrollmentId: string,
    expectedCredentialHash: string,
    credentialHash: string,
    now?: number,
  ): boolean;
  list(): DeviceInfo[];
  rename(id: string, name: string): DeviceInfo | undefined;
  revoke(id: string): boolean;
  revokeAll(): number;
  close(): void;
}

export interface OpenDeviceStoreOptions {
  /** SQLite file path. ":memory:" uses an in-process DB. */
  dbPath: string;
  generateSecret?: () => string;
  generateToken?: () => string;
  generateId?: () => string;
  /** Test/portable hook; a loader failure selects the bounded in-memory fallback. */
  loadDatabase?: () => typeof import("better-sqlite3");
}

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  scopes_json: string;
  relay_public_key?: string | null;
  relay_fingerprint?: string | null;
}

interface PairingRow {
  secret_hash: string;
  expires_at: number;
  scopes_json: string;
  device_id?: string | null;
  token_hash?: string | null;
  cancellation_id?: string | null;
}

interface CloudEnrollmentRow {
  enrollment_id: string;
  device_id: string;
  challenge_hash: string;
  token_hash: string;
  name: string;
  relay_public_key: string;
  relay_fingerprint: string;
  temporary_credential_hash?: string | null;
  durable_credential_hash: string;
  control_plane_device_id?: string | null;
  broker_promoted_at?: number | null;
  revoked_at?: number | null;
  state: PersistedCloudDeviceEnrollmentState;
  recovery_order: number;
  created_at: number;
  updated_at: number;
}

export function normalizeDeviceScopes(value: unknown): DeviceScope[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const scopes = [...new Set(value)];
  if (scopes.some((scope) => scope !== "direct" && scope !== "relay")) return undefined;
  return scopes as DeviceScope[];
}

function scopesFromJson(value: string): DeviceScope[] {
  try {
    return normalizeDeviceScopes(JSON.parse(value)) ?? ["direct"];
  } catch {
    return ["direct"];
  }
}

function rowToDevice(row: DeviceRow): DeviceInfo {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    scopes: scopesFromJson(row.scopes_json),
    ...(row.relay_fingerprint ? { relayIdentityFingerprint: row.relay_fingerprint } : {}),
  };
}

function relayIdentityForClaim(scopes: DeviceScope[], publicKey: string | undefined): DeviceRelayIdentity | undefined {
  if (!scopes.includes("relay")) return undefined;
  if (typeof publicKey !== "string") {
    throw new DevicePairingError("INVALID_RELAY_IDENTITY", "relay pairing requires a device E2E identity");
  }
  try {
    return { publicKey, fingerprint: relayIdentityFingerprint(publicKey) };
  } catch {
    throw new DevicePairingError("INVALID_RELAY_IDENTITY", "relay identity must be a P-256 public key");
  }
}

function relayIdentityFromRow(row: DeviceRow | undefined): DeviceRelayIdentity | undefined {
  if (!row?.relay_public_key || !row.relay_fingerprint) return undefined;
  return { publicKey: row.relay_public_key, fingerprint: row.relay_fingerprint };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeCloudCredentialHash(value: unknown): string {
  if (typeof value !== "string" || !RELAY_CREDENTIAL_HASH.test(value)) {
    throw new CloudDeviceEnrollmentConflictError();
  }
  return value;
}

function safeCloudPromotionLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError("cloud device promotion limit must be between 1 and 100");
  }
  return value;
}

function normalizeCloudEnrollmentInput(
  input: CloudDeviceEnrollmentPrepareInput,
): CloudDeviceEnrollmentPrepareInput & { name: string; relayIdentityFingerprint: string } {
  const name = normalizeDeviceName(input.name);
  if (
    !UUID.test(input.enrollmentId) ||
    !SAFE_IDENTIFIER.test(input.deviceId) ||
    !CLOUD_CHALLENGE.test(input.challenge) ||
    !DEVICE_TOKEN.test(input.token) ||
    !name
  ) {
    throw new CloudDeviceEnrollmentConflictError();
  }
  const identity = relayIdentityForClaim(["relay"], input.relayIdentityPublicKey);
  if (!identity) throw new CloudDeviceEnrollmentConflictError();
  return {
    ...input,
    name,
    durableRelayCredentialHash: safeCloudCredentialHash(input.durableRelayCredentialHash),
    relayIdentityFingerprint: identity.fingerprint,
  };
}

function cloudEnrollmentMatches(
  row: CloudEnrollmentRow,
  input: ReturnType<typeof normalizeCloudEnrollmentInput>,
): boolean {
  return (
    row.device_id === input.deviceId &&
    row.challenge_hash === digest(input.challenge) &&
    row.token_hash === digest(input.token) &&
    row.name === input.name &&
    row.relay_public_key === input.relayIdentityPublicKey &&
    row.relay_fingerprint === input.relayIdentityFingerprint &&
    row.durable_credential_hash === input.durableRelayCredentialHash
  );
}

function cloudProgress(row: CloudEnrollmentRow, device?: DeviceInfo): CloudDeviceEnrollmentProgress {
  const revoked = row.revoked_at !== null && row.revoked_at !== undefined;
  const brokerPromoted = row.broker_promoted_at !== null && row.broker_promoted_at !== undefined;
  const state: CloudDeviceEnrollmentState = revoked
    ? "revoked"
    : row.state === "local-finalized" && brokerPromoted
      ? "cloud-report-pending"
      : row.state;
  return {
    enrollmentId: row.enrollment_id,
    deviceId: row.device_id,
    state,
    durableRelayCredentialHash: row.durable_credential_hash,
    ...(row.temporary_credential_hash ? { temporaryRelayCredentialHash: row.temporary_credential_hash } : {}),
    ...(row.control_plane_device_id ? { controlPlaneDeviceId: row.control_plane_device_id } : {}),
    ...(device ? { device } : {}),
  };
}

function randomCredential(prefix: "rcp" | "rcd"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Keep device labels useful in UI while refusing control characters and unbounded payloads. */
export function normalizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || UNSAFE_DISPLAY_TEXT.test(normalized)) return undefined;
  return normalized;
}

function inMemoryStore(opts: OpenDeviceStoreOptions): DeviceStore {
  const devices = new Map<string, DeviceRow>();
  const tokenToId = new Map<string, string>();
  const pairings = new Map<
    string,
    {
      expiresAt: number;
      scopes: DeviceScope[];
      deviceId?: string;
      tokenHash?: string;
      cancellationId?: string;
    }
  >();
  const cloudEnrollments = new Map<string, CloudEnrollmentRow>();
  const cloudDeviceIds = new Set<string>();
  const cloudTokenHashes = new Set<string>();
  const cloudChallengeHashes = new Set<string>();
  const cloudDurableCredentialHashes = new Set<string>();
  const pendingCloudPromotions = new Map<string, true>();
  const pendingCloudDeviceIds = new Set<string>();
  const prunableCloudEnrollments = new Map<string, true>();
  let cloudRecoveryOrder = 0;
  const generateSecret = opts.generateSecret ?? (() => randomCredential("rcp"));
  const generateToken = opts.generateToken ?? (() => randomCredential("rcd"));
  const generateId = opts.generateId ?? randomUUID;

  const forgetCloudEnrollment = (enrollment: CloudEnrollmentRow) => {
    cloudEnrollments.delete(enrollment.enrollment_id);
    cloudDeviceIds.delete(enrollment.device_id);
    cloudTokenHashes.delete(enrollment.token_hash);
    cloudChallengeHashes.delete(enrollment.challenge_hash);
    cloudDurableCredentialHashes.delete(enrollment.durable_credential_hash);
    pendingCloudPromotions.delete(enrollment.enrollment_id);
    pendingCloudDeviceIds.delete(enrollment.device_id);
    prunableCloudEnrollments.delete(enrollment.enrollment_id);
  };

  const pruneCloudEnrollments = (now: number) => {
    let inspected = 0;
    for (const enrollmentId of prunableCloudEnrollments.keys()) {
      if (inspected >= CLOUD_ENROLLMENT_PRUNE_BATCH) break;
      inspected += 1;
      prunableCloudEnrollments.delete(enrollmentId);
      const enrollment = cloudEnrollments.get(enrollmentId);
      if (!enrollment) continue;
      const expired =
        (enrollment.state === "prepared" && enrollment.updated_at < now - CLOUD_PREPARED_ENROLLMENT_RETENTION_MS) ||
        ((enrollment.state === "complete" || enrollment.revoked_at !== undefined) &&
          enrollment.updated_at < now - CLOUD_ENROLLMENT_RETENTION_MS);
      if (expired) forgetCloudEnrollment(enrollment);
      else prunableCloudEnrollments.set(enrollmentId, true);
    }
  };

  const prune = (now: number) => {
    for (const [secretHash, pairing] of pairings) {
      if (pairing.expiresAt < now) pairings.delete(secretHash);
    }
    pruneCloudEnrollments(now);
  };

  return {
    mode: "memory-fallback",
    issuePairing(now = Date.now(), rawScopes = ["direct"]) {
      const scopes = normalizeDeviceScopes(rawScopes);
      if (!scopes) throw new Error("invalid device scopes");
      prune(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const secretHash = digest(secret);
        if (pairings.has(secretHash)) continue;
        const expiresAt = now + PAIRING_TTL_MS;
        pairings.set(secretHash, { expiresAt, scopes });
        return { secret, expiresAt, scopes: [...scopes] };
      }
      throw new Error("could not allocate a unique pairing credential");
    },
    cancelPairing: (secret) => pairings.delete(digest(secret)),
    claimPairing(secret, rawName, now = Date.now(), relayIdentityPublicKey) {
      const name = normalizeDeviceName(rawName);
      if (!name) return undefined;
      prune(now);
      const secretHash = digest(secret);
      const pairing = pairings.get(secretHash);
      if (pairing === undefined || pairing.expiresAt < now || pairing.deviceId || pairing.tokenHash) return undefined;
      const relayIdentity = relayIdentityForClaim(pairing.scopes, relayIdentityPublicKey);
      // Delete BEFORE issuing the durable credential: concurrent/repeated claims cannot both win.
      pairings.delete(secretHash);
      const token = generateToken();
      const id = generateId();
      const row: DeviceRow = {
        id,
        name,
        token_hash: digest(token),
        created_at: now,
        last_seen_at: now,
        scopes_json: JSON.stringify(pairing.scopes),
        relay_public_key: relayIdentity?.publicKey,
        relay_fingerprint: relayIdentity?.fingerprint,
      };
      devices.set(id, row);
      tokenToId.set(row.token_hash, id);
      return { token, device: rowToDevice(row) };
    },
    issueRelayPairing(now = Date.now()) {
      prune(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const token = generateToken();
        const deviceId = generateId();
        const secretHash = digest(secret);
        if (
          pairings.has(secretHash) ||
          tokenToId.has(digest(token)) ||
          devices.has(deviceId) ||
          [...pairings.values()].some((pairing) => pairing.deviceId === deviceId || pairing.tokenHash === digest(token))
        )
          continue;
        const expiresAt = now + PAIRING_TTL_MS;
        pairings.set(secretHash, {
          expiresAt,
          scopes: ["relay"],
          deviceId,
          tokenHash: digest(token),
        });
        return { secret, expiresAt, scopes: ["relay"], deviceId, token };
      }
      throw new Error("could not allocate a unique relay pairing credential");
    },
    pendingRelayPairing(deviceId, now = Date.now()) {
      prune(now);
      return [...pairings.values()].some((pairing) => pairing.deviceId === deviceId && pairing.expiresAt >= now);
    },
    beginRelayPairingCancellation(deviceId, now = Date.now()) {
      prune(now);
      const pairing = [...pairings.values()].find((candidate) => candidate.deviceId === deviceId);
      if (!pairing || pairing.expiresAt < now) return { status: "missing" };
      if (pairing.cancellationId) return { status: "busy" };
      const reservation = { deviceId, reservationId: randomUUID() };
      pairing.cancellationId = reservation.reservationId;
      return { status: "reserved", reservation };
    },
    releaseRelayPairingCancellation(reservation) {
      const pairing = [...pairings.values()].find((candidate) => candidate.deviceId === reservation.deviceId);
      if (pairing?.cancellationId !== reservation.reservationId) return false;
      delete pairing.cancellationId;
      return true;
    },
    finishRelayPairingCancellation(reservation) {
      for (const [secretHash, pairing] of pairings) {
        if (pairing.deviceId === reservation.deviceId && pairing.cancellationId === reservation.reservationId) {
          pairings.delete(secretHash);
          return true;
        }
      }
      return false;
    },
    cancelRelayPairing(deviceId) {
      for (const [secretHash, pairing] of pairings) {
        if (pairing.deviceId === deviceId) {
          pairings.delete(secretHash);
          return true;
        }
      }
      return false;
    },
    claimRelayPairing(secret, token, rawName, relayIdentityPublicKey, now = Date.now()) {
      const name = normalizeDeviceName(rawName);
      if (!name || !/^rcd_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      prune(now);
      const secretHash = digest(secret);
      const pairing = pairings.get(secretHash);
      if (
        !pairing?.deviceId ||
        !pairing.tokenHash ||
        pairing.cancellationId ||
        pairing.expiresAt < now ||
        pairing.tokenHash !== digest(token)
      )
        return undefined;
      const relayIdentity = relayIdentityForClaim(pairing.scopes, relayIdentityPublicKey);
      pairings.delete(secretHash);
      const row: DeviceRow = {
        id: pairing.deviceId,
        name,
        token_hash: pairing.tokenHash,
        created_at: now,
        last_seen_at: now,
        scopes_json: JSON.stringify(pairing.scopes),
        relay_public_key: relayIdentity?.publicKey,
        relay_fingerprint: relayIdentity?.fingerprint,
      };
      devices.set(row.id, row);
      tokenToId.set(row.token_hash, row.id);
      return { token, device: rowToDevice(row) };
    },
    authenticate(token, now = Date.now(), requiredScope = "direct") {
      const id = tokenToId.get(digest(token));
      if (!id) return undefined;
      const row = devices.get(id);
      if (!row) return undefined;
      if (!scopesFromJson(row.scopes_json).includes(requiredScope)) return undefined;
      if (requiredScope === "relay" && pendingCloudDeviceIds.has(row.id)) {
        return undefined;
      }
      if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) row.last_seen_at = now;
      return rowToDevice(row);
    },
    relayIdentity: (id) => relayIdentityFromRow(devices.get(id)),
    beginCloudDeviceEnrollment(rawInput, now = Date.now()) {
      prune(now);
      let input: ReturnType<typeof normalizeCloudEnrollmentInput>;
      try {
        input = normalizeCloudEnrollmentInput(rawInput);
      } catch {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const existing = cloudEnrollments.get(input.enrollmentId);
      if (existing) {
        if (!cloudEnrollmentMatches(existing, input)) throw new CloudDeviceEnrollmentConflictError();
        return cloudProgress(
          existing,
          devices.get(existing.device_id) ? rowToDevice(devices.get(existing.device_id)!) : undefined,
        );
      }
      const tokenHash = digest(input.token);
      const challengeHash = digest(input.challenge);
      if (
        devices.has(input.deviceId) ||
        tokenToId.has(tokenHash) ||
        [...pairings.values()].some(
          (pairing) => pairing.deviceId === input.deviceId || pairing.tokenHash === tokenHash,
        ) ||
        cloudDeviceIds.has(input.deviceId) ||
        cloudTokenHashes.has(tokenHash) ||
        cloudChallengeHashes.has(challengeHash) ||
        cloudDurableCredentialHashes.has(input.durableRelayCredentialHash)
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const row: CloudEnrollmentRow = {
        enrollment_id: input.enrollmentId,
        device_id: input.deviceId,
        challenge_hash: challengeHash,
        token_hash: tokenHash,
        name: input.name,
        relay_public_key: input.relayIdentityPublicKey,
        relay_fingerprint: input.relayIdentityFingerprint,
        durable_credential_hash: input.durableRelayCredentialHash,
        state: "prepared",
        recovery_order: 0,
        created_at: now,
        updated_at: now,
      };
      cloudEnrollments.set(row.enrollment_id, row);
      cloudDeviceIds.add(row.device_id);
      cloudTokenHashes.add(row.token_hash);
      cloudChallengeHashes.add(row.challenge_hash);
      cloudDurableCredentialHashes.add(row.durable_credential_hash);
      prunableCloudEnrollments.set(row.enrollment_id, true);
      return cloudProgress(row);
    },
    finalizeCloudDeviceEnrollment(enrollmentId, temporaryRelayCredentialHash, controlPlaneDeviceId, now = Date.now()) {
      prune(now);
      if (!UUID.test(enrollmentId) || !UUID.test(controlPlaneDeviceId)) throw new CloudDeviceEnrollmentConflictError();
      const temporaryHash = safeCloudCredentialHash(temporaryRelayCredentialHash);
      const enrollment = cloudEnrollments.get(enrollmentId);
      if (!enrollment) throw new CloudDeviceEnrollmentConflictError();
      if (enrollment.temporary_credential_hash && enrollment.temporary_credential_hash !== temporaryHash) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.control_plane_device_id && enrollment.control_plane_device_id !== controlPlaneDeviceId) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      let row = devices.get(enrollment.device_id);
      if (enrollment.state === "prepared") {
        const tokenOwner = tokenToId.get(enrollment.token_hash);
        if (
          (tokenOwner && tokenOwner !== enrollment.device_id) ||
          (row &&
            (row.token_hash !== enrollment.token_hash ||
              row.name !== enrollment.name ||
              row.scopes_json !== JSON.stringify(["relay"]) ||
              row.relay_public_key !== enrollment.relay_public_key ||
              row.relay_fingerprint !== enrollment.relay_fingerprint))
        ) {
          throw new CloudDeviceEnrollmentConflictError();
        }
        if (!row) {
          row = {
            id: enrollment.device_id,
            name: enrollment.name,
            token_hash: enrollment.token_hash,
            created_at: now,
            last_seen_at: now,
            scopes_json: JSON.stringify(["relay"] satisfies DeviceScope[]),
            relay_public_key: enrollment.relay_public_key,
            relay_fingerprint: enrollment.relay_fingerprint,
          };
          devices.set(row.id, row);
          tokenToId.set(row.token_hash, row.id);
        }
        enrollment.temporary_credential_hash = temporaryHash;
        enrollment.control_plane_device_id = controlPlaneDeviceId;
        enrollment.state = "local-finalized";
        enrollment.recovery_order = ++cloudRecoveryOrder;
        enrollment.updated_at = now;
        prunableCloudEnrollments.delete(enrollment.enrollment_id);
        pendingCloudPromotions.set(enrollment.enrollment_id, true);
        pendingCloudDeviceIds.add(enrollment.device_id);
      }
      return cloudProgress(enrollment, row ? rowToDevice(row) : undefined);
    },
    markCloudDeviceEnrollmentPromoted(enrollmentId, expectedCredentialHash, credentialHash, now = Date.now()) {
      prune(now);
      if (!UUID.test(enrollmentId)) throw new CloudDeviceEnrollmentConflictError();
      const expectedHash = safeCloudCredentialHash(expectedCredentialHash);
      const durableHash = safeCloudCredentialHash(credentialHash);
      const enrollment = cloudEnrollments.get(enrollmentId);
      if (
        !enrollment ||
        enrollment.state === "prepared" ||
        enrollment.revoked_at !== undefined ||
        !enrollment.control_plane_device_id ||
        enrollment.temporary_credential_hash !== expectedHash ||
        enrollment.durable_credential_hash !== durableHash
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.state === "local-finalized" && enrollment.broker_promoted_at === undefined) {
        enrollment.broker_promoted_at = now;
        enrollment.updated_at = now;
      }
      return cloudProgress(
        enrollment,
        devices.get(enrollment.device_id) ? rowToDevice(devices.get(enrollment.device_id)!) : undefined,
      );
    },
    completeCloudDeviceEnrollment(enrollmentId, expectedCredentialHash, credentialHash, now = Date.now()) {
      prune(now);
      if (!UUID.test(enrollmentId)) throw new CloudDeviceEnrollmentConflictError();
      const expectedHash = safeCloudCredentialHash(expectedCredentialHash);
      const durableHash = safeCloudCredentialHash(credentialHash);
      const enrollment = cloudEnrollments.get(enrollmentId);
      if (
        !enrollment ||
        enrollment.state === "prepared" ||
        enrollment.revoked_at !== undefined ||
        enrollment.broker_promoted_at === undefined ||
        enrollment.temporary_credential_hash !== expectedHash ||
        enrollment.durable_credential_hash !== durableHash
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const row = devices.get(enrollment.device_id);
      if (!row) throw new CloudDeviceEnrollmentConflictError();
      enrollment.state = "complete";
      enrollment.updated_at = now;
      pendingCloudPromotions.delete(enrollment.enrollment_id);
      pendingCloudDeviceIds.delete(enrollment.device_id);
      prunableCloudEnrollments.set(enrollment.enrollment_id, true);
      return cloudProgress(enrollment, rowToDevice(row));
    },
    revokeCloudDeviceEnrollment(
      enrollmentId,
      controlPlaneDeviceId,
      expectedCredentialHash,
      credentialHash,
      now = Date.now(),
    ) {
      prune(now);
      if (!UUID.test(enrollmentId) || !UUID.test(controlPlaneDeviceId)) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const expectedHash = safeCloudCredentialHash(expectedCredentialHash);
      const durableHash = safeCloudCredentialHash(credentialHash);
      const enrollment = cloudEnrollments.get(enrollmentId);
      if (
        !enrollment ||
        enrollment.state === "prepared" ||
        enrollment.control_plane_device_id !== controlPlaneDeviceId ||
        enrollment.temporary_credential_hash !== expectedHash ||
        enrollment.durable_credential_hash !== durableHash
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.revoked_at === undefined) {
        const row = devices.get(enrollment.device_id);
        if (row) tokenToId.delete(row.token_hash);
        devices.delete(enrollment.device_id);
        enrollment.revoked_at = now;
        enrollment.updated_at = now;
        pendingCloudPromotions.delete(enrollment.enrollment_id);
        pendingCloudDeviceIds.delete(enrollment.device_id);
        prunableCloudEnrollments.set(enrollment.enrollment_id, true);
      }
      return cloudProgress(enrollment);
    },
    cloudDeviceEnrollmentPending(deviceId) {
      if (!SAFE_IDENTIFIER.test(deviceId)) return false;
      return pendingCloudDeviceIds.has(deviceId);
    },
    pendingCloudDevicePromotions(now = Date.now(), limit = 25) {
      pruneCloudEnrollments(now);
      const page: PendingCloudDevicePromotion[] = [];
      const boundedLimit = safeCloudPromotionLimit(limit);
      for (const enrollmentId of pendingCloudPromotions.keys()) {
        if (page.length >= boundedLimit) break;
        const enrollment = cloudEnrollments.get(enrollmentId);
        if (
          !enrollment ||
          enrollment.state !== "local-finalized" ||
          enrollment.revoked_at !== undefined ||
          typeof enrollment.temporary_credential_hash !== "string"
        ) {
          pendingCloudPromotions.delete(enrollmentId);
          if (enrollment) pendingCloudDeviceIds.delete(enrollment.device_id);
          continue;
        }
        page.push({
          enrollmentId: enrollment.enrollment_id,
          deviceId: enrollment.device_id,
          expectedCredentialHash: enrollment.temporary_credential_hash,
          credentialHash: enrollment.durable_credential_hash,
          controlPlaneDeviceId: enrollment.control_plane_device_id!,
          brokerPromoted: enrollment.broker_promoted_at !== undefined,
        });
      }
      return page;
    },
    deferCloudDevicePromotion(enrollmentId, expectedCredentialHash, credentialHash, now = Date.now()) {
      if (!UUID.test(enrollmentId)) return false;
      let expectedHash: string;
      let durableHash: string;
      try {
        expectedHash = safeCloudCredentialHash(expectedCredentialHash);
        durableHash = safeCloudCredentialHash(credentialHash);
      } catch {
        return false;
      }
      const enrollment = cloudEnrollments.get(enrollmentId);
      if (
        !enrollment ||
        enrollment.state !== "local-finalized" ||
        enrollment.revoked_at !== undefined ||
        enrollment.temporary_credential_hash !== expectedHash ||
        enrollment.durable_credential_hash !== durableHash
      ) {
        return false;
      }
      enrollment.recovery_order = ++cloudRecoveryOrder;
      enrollment.updated_at = now;
      pendingCloudPromotions.delete(enrollment.enrollment_id);
      pendingCloudPromotions.set(enrollment.enrollment_id, true);
      return true;
    },
    list: () => [...devices.values()].sort((a, b) => b.last_seen_at - a.last_seen_at).map(rowToDevice),
    rename(id, rawName) {
      const name = normalizeDeviceName(rawName);
      const row = devices.get(id);
      if (!name || !row) return undefined;
      row.name = name;
      return rowToDevice(row);
    },
    revoke(id) {
      const row = devices.get(id);
      if (!row) return false;
      tokenToId.delete(row.token_hash);
      devices.delete(id);
      const enrollment = [...cloudEnrollments.values()].find((candidate) => candidate.device_id === id);
      if (enrollment && enrollment.state !== "prepared") {
        const now = Date.now();
        enrollment.revoked_at ??= now;
        enrollment.updated_at = now;
        pendingCloudPromotions.delete(enrollment.enrollment_id);
        pendingCloudDeviceIds.delete(id);
        prunableCloudEnrollments.set(enrollment.enrollment_id, true);
      }
      return true;
    },
    revokeAll() {
      const count = devices.size;
      const now = Date.now();
      for (const enrollment of cloudEnrollments.values()) {
        if (enrollment.state === "prepared" || !devices.has(enrollment.device_id)) continue;
        enrollment.revoked_at ??= now;
        enrollment.updated_at = now;
        pendingCloudPromotions.delete(enrollment.enrollment_id);
        pendingCloudDeviceIds.delete(enrollment.device_id);
        prunableCloudEnrollments.set(enrollment.enrollment_id, true);
      }
      devices.clear();
      tokenToId.clear();
      return count;
    },
    close() {
      devices.clear();
      tokenToId.clear();
      pairings.clear();
      cloudEnrollments.clear();
      cloudDeviceIds.clear();
      cloudTokenHashes.clear();
      cloudChallengeHashes.clear();
      cloudDurableCredentialHashes.clear();
      pendingCloudPromotions.clear();
      pendingCloudDeviceIds.clear();
      prunableCloudEnrollments.clear();
    },
  };
}

export function openDeviceStore(opts: OpenDeviceStoreOptions): DeviceStore {
  let Database: typeof import("better-sqlite3");
  try {
    const mod = (opts.loadDatabase?.() ?? require("better-sqlite3")) as {
      default?: typeof import("better-sqlite3");
    };
    Database = (mod.default ?? mod) as typeof import("better-sqlite3");
  } catch {
    return inMemoryStore(opts);
  }

  const db = new Database(opts.dbPath);
  db.pragma("journal_mode = WAL");
  // `roamcode pair` deliberately writes through a short-lived second connection while the service is
  // running. Wait through a brief writer overlap instead of failing a perfectly valid pairing attempt.
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["direct"]',
      relay_public_key TEXT,
      relay_fingerprint TEXT
    );
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      secret_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '["direct"]',
      device_id TEXT,
      token_hash TEXT,
      cancellation_id TEXT
    );
    CREATE TABLE IF NOT EXISTS cloud_device_enrollments (
      enrollment_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      challenge_hash TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      relay_public_key TEXT NOT NULL,
      relay_fingerprint TEXT NOT NULL,
      temporary_credential_hash TEXT,
      durable_credential_hash TEXT NOT NULL UNIQUE,
      control_plane_device_id TEXT,
      broker_promoted_at INTEGER,
      revoked_at INTEGER,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'local-finalized', 'complete')),
      recovery_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS pairing_expiry_idx ON pairing_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS cloud_device_enrollment_state_idx ON cloud_device_enrollments(state, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS cloud_device_enrollment_temp_credential_idx
      ON cloud_device_enrollments(temporary_credential_hash) WHERE temporary_credential_hash IS NOT NULL;
  `);
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  if (!deviceColumns.some((column) => column.name === "scopes_json")) {
    db.exec(`ALTER TABLE devices ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["direct"]'`);
  }
  if (!deviceColumns.some((column) => column.name === "relay_public_key")) {
    db.exec("ALTER TABLE devices ADD COLUMN relay_public_key TEXT");
  }
  if (!deviceColumns.some((column) => column.name === "relay_fingerprint")) {
    db.exec("ALTER TABLE devices ADD COLUMN relay_fingerprint TEXT");
  }
  const pairingColumns = db.prepare("PRAGMA table_info(pairing_sessions)").all() as Array<{ name: string }>;
  if (!pairingColumns.some((column) => column.name === "scopes_json")) {
    db.exec(`ALTER TABLE pairing_sessions ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["direct"]'`);
  }
  if (!pairingColumns.some((column) => column.name === "device_id")) {
    db.exec("ALTER TABLE pairing_sessions ADD COLUMN device_id TEXT");
  }
  if (!pairingColumns.some((column) => column.name === "token_hash")) {
    db.exec("ALTER TABLE pairing_sessions ADD COLUMN token_hash TEXT");
  }
  if (!pairingColumns.some((column) => column.name === "cancellation_id")) {
    db.exec("ALTER TABLE pairing_sessions ADD COLUMN cancellation_id TEXT");
  }
  const cloudEnrollmentColumns = db.prepare("PRAGMA table_info(cloud_device_enrollments)").all() as Array<{
    name: string;
  }>;
  if (!cloudEnrollmentColumns.some((column) => column.name === "recovery_order")) {
    db.exec("ALTER TABLE cloud_device_enrollments ADD COLUMN recovery_order INTEGER NOT NULL DEFAULT 0");
  }
  if (!cloudEnrollmentColumns.some((column) => column.name === "control_plane_device_id")) {
    db.exec("ALTER TABLE cloud_device_enrollments ADD COLUMN control_plane_device_id TEXT");
  }
  if (!cloudEnrollmentColumns.some((column) => column.name === "broker_promoted_at")) {
    db.exec("ALTER TABLE cloud_device_enrollments ADD COLUMN broker_promoted_at INTEGER");
  }
  if (!cloudEnrollmentColumns.some((column) => column.name === "revoked_at")) {
    db.exec("ALTER TABLE cloud_device_enrollments ADD COLUMN revoked_at INTEGER");
  }
  // Older prerelease rows never persisted the control-plane device binding. They cannot safely report completion
  // or prove which remote device is being activated, so retire both the local actor and enrollment fail-closed.
  db.exec(`
    UPDATE cloud_device_enrollments
    SET revoked_at = COALESCE(revoked_at, updated_at), updated_at = updated_at
    WHERE state != 'prepared' AND control_plane_device_id IS NULL;
    DELETE FROM devices WHERE id IN (
      SELECT device_id FROM cloud_device_enrollments
      WHERE state != 'prepared' AND control_plane_device_id IS NULL
    );
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS pairing_device_id_idx ON pairing_sessions(device_id) WHERE device_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS pairing_token_hash_idx ON pairing_sessions(token_hash) WHERE token_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS cloud_device_enrollment_recovery_idx
      ON cloud_device_enrollments(state, recovery_order, created_at, enrollment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS cloud_device_enrollment_control_plane_device_idx
      ON cloud_device_enrollments(control_plane_device_id) WHERE control_plane_device_id IS NOT NULL;
  `);

  const generateSecret = opts.generateSecret ?? (() => randomCredential("rcp"));
  const generateToken = opts.generateToken ?? (() => randomCredential("rcd"));
  const generateId = opts.generateId ?? randomUUID;
  const insertPairing = db.prepare(
    "INSERT INTO pairing_sessions (secret_hash, created_at, expires_at, scopes_json) VALUES (?, ?, ?, ?)",
  );
  const insertRelayPairing = db.prepare(
    "INSERT INTO pairing_sessions (secret_hash, created_at, expires_at, scopes_json, device_id, token_hash) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const prunePairings = db.prepare("DELETE FROM pairing_sessions WHERE expires_at < ?");
  const cancelPairing = db.prepare("DELETE FROM pairing_sessions WHERE secret_hash = ?");
  const findPairing = db.prepare(
    "SELECT secret_hash, expires_at, scopes_json, device_id, token_hash, cancellation_id FROM pairing_sessions WHERE secret_hash = ?",
  );
  const findPendingRelayPairing = db.prepare(
    "SELECT 1 FROM pairing_sessions WHERE device_id = ? AND expires_at >= ? LIMIT 1",
  );
  const cancelRelayPairing = db.prepare("DELETE FROM pairing_sessions WHERE device_id = ?");
  const findRelayPairingByDevice = db.prepare(
    "SELECT secret_hash, expires_at, scopes_json, device_id, token_hash, cancellation_id FROM pairing_sessions WHERE device_id = ?",
  );
  const reserveRelayPairingCancellation = db.prepare(
    "UPDATE pairing_sessions SET cancellation_id = ? WHERE device_id = ? AND cancellation_id IS NULL",
  );
  const releaseRelayPairingCancellation = db.prepare(
    "UPDATE pairing_sessions SET cancellation_id = NULL WHERE device_id = ? AND cancellation_id = ?",
  );
  const finishRelayPairingCancellation = db.prepare(
    "DELETE FROM pairing_sessions WHERE device_id = ? AND cancellation_id = ?",
  );
  const deletePairing = db.prepare("DELETE FROM pairing_sessions WHERE secret_hash = ?");
  const insertDevice = db.prepare(
    "INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, scopes_json, relay_public_key, relay_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const findDeviceByToken = db.prepare("SELECT * FROM devices WHERE token_hash = ?");
  const findDeviceById = db.prepare("SELECT * FROM devices WHERE id = ?");
  const listDevices = db.prepare("SELECT * FROM devices ORDER BY last_seen_at DESC, created_at DESC");
  const touchDevice = db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
  const renameDevice = db.prepare("UPDATE devices SET name = ? WHERE id = ?");
  const revokeDevice = db.prepare("DELETE FROM devices WHERE id = ?");
  const revokeAllDevices = db.prepare("DELETE FROM devices");
  const insertCloudEnrollment = db.prepare(
    `INSERT INTO cloud_device_enrollments
      (enrollment_id, device_id, challenge_hash, token_hash, name, relay_public_key, relay_fingerprint,
       durable_credential_hash, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
  );
  const findCloudEnrollment = db.prepare("SELECT * FROM cloud_device_enrollments WHERE enrollment_id = ?");
  const findCloudEnrollmentConflict = db.prepare(
    `SELECT 1 FROM cloud_device_enrollments
     WHERE device_id = ? OR token_hash = ? OR challenge_hash = ? OR durable_credential_hash = ? LIMIT 1`,
  );
  const findPairingByToken = db.prepare("SELECT 1 FROM pairing_sessions WHERE token_hash = ? LIMIT 1");
  const finalizeCloudEnrollment = db.prepare(
    `UPDATE cloud_device_enrollments
     SET temporary_credential_hash = ?, control_plane_device_id = ?, state = 'local-finalized',
       recovery_order = (SELECT COALESCE(MAX(recovery_order), 0) + 1
         FROM cloud_device_enrollments WHERE state = 'local-finalized'),
       updated_at = ?
     WHERE enrollment_id = ? AND state = 'prepared' AND revoked_at IS NULL`,
  );
  const markCloudEnrollmentPromoted = db.prepare(
    `UPDATE cloud_device_enrollments SET broker_promoted_at = ?, updated_at = ?
     WHERE enrollment_id = ? AND state = 'local-finalized' AND revoked_at IS NULL
       AND broker_promoted_at IS NULL
       AND temporary_credential_hash = ? AND durable_credential_hash = ?`,
  );
  const completeCloudEnrollment = db.prepare(
    `UPDATE cloud_device_enrollments SET state = 'complete', updated_at = ?
     WHERE enrollment_id = ? AND state = 'local-finalized' AND revoked_at IS NULL
       AND broker_promoted_at IS NOT NULL
       AND temporary_credential_hash = ? AND durable_credential_hash = ?`,
  );
  const revokeCloudEnrollment = db.prepare(
    `UPDATE cloud_device_enrollments SET revoked_at = ?, updated_at = ?
     WHERE enrollment_id = ? AND state != 'prepared'
       AND control_plane_device_id = ?
       AND temporary_credential_hash = ? AND durable_credential_hash = ?`,
  );
  const listPendingCloudPromotions = db.prepare(
    `SELECT * FROM cloud_device_enrollments
     WHERE state = 'local-finalized' AND revoked_at IS NULL
       AND temporary_credential_hash IS NOT NULL AND control_plane_device_id IS NOT NULL
     ORDER BY recovery_order ASC, created_at ASC, enrollment_id ASC LIMIT ?`,
  );
  const deferCloudPromotion = db.prepare(
    `UPDATE cloud_device_enrollments
     SET recovery_order = (SELECT COALESCE(MAX(recovery_order), 0) + 1
       FROM cloud_device_enrollments WHERE state = 'local-finalized'), updated_at = ?
     WHERE enrollment_id = ? AND state = 'local-finalized' AND revoked_at IS NULL
       AND temporary_credential_hash = ? AND durable_credential_hash = ?`,
  );
  const findPendingCloudEnrollmentByDevice = db.prepare(
    "SELECT 1 FROM cloud_device_enrollments WHERE device_id = ? AND state = 'local-finalized' AND revoked_at IS NULL LIMIT 1",
  );
  const pruneCompletedCloudEnrollments = db.prepare(
    `DELETE FROM cloud_device_enrollments WHERE enrollment_id IN (
       SELECT enrollment_id FROM cloud_device_enrollments
       WHERE state = 'complete' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?
     )`,
  );
  const prunePreparedCloudEnrollments = db.prepare(
    `DELETE FROM cloud_device_enrollments WHERE enrollment_id IN (
       SELECT enrollment_id FROM cloud_device_enrollments
       WHERE state = 'prepared' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?
     )`,
  );
  const pruneRevokedCloudEnrollments = db.prepare(
    `DELETE FROM cloud_device_enrollments WHERE enrollment_id IN (
       SELECT enrollment_id FROM cloud_device_enrollments
       WHERE revoked_at IS NOT NULL AND updated_at < ? ORDER BY updated_at ASC LIMIT ?
     )`,
  );
  const tombstoneCloudEnrollmentByDevice = db.prepare(
    `UPDATE cloud_device_enrollments SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
     WHERE device_id = ? AND state != 'prepared'`,
  );
  const tombstoneAllCloudEnrollments = db.prepare(
    `UPDATE cloud_device_enrollments SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
     WHERE state != 'prepared' AND device_id IN (SELECT id FROM devices)`,
  );
  const pruneCloudEnrollmentHistory = (now: number) => {
    pruneCompletedCloudEnrollments.run(now - CLOUD_ENROLLMENT_RETENTION_MS, CLOUD_ENROLLMENT_PRUNE_BATCH);
    prunePreparedCloudEnrollments.run(now - CLOUD_PREPARED_ENROLLMENT_RETENTION_MS, CLOUD_ENROLLMENT_PRUNE_BATCH);
    pruneRevokedCloudEnrollments.run(now - CLOUD_ENROLLMENT_RETENTION_MS, CLOUD_ENROLLMENT_PRUNE_BATCH);
  };

  const claim = db.transaction(
    (
      secretHash: string,
      name: string,
      now: number,
      token: string,
      id: string,
      relayIdentityPublicKey: string | undefined,
    ): DeviceEnrollment | undefined => {
      prunePairings.run(now);
      const pairing = findPairing.get(secretHash) as PairingRow | undefined;
      if (!pairing || pairing.expires_at < now || pairing.device_id || pairing.token_hash) return undefined;
      const scopes = scopesFromJson(pairing.scopes_json);
      const relayIdentity = relayIdentityForClaim(scopes, relayIdentityPublicKey);
      deletePairing.run(secretHash);
      insertDevice.run(
        id,
        name,
        digest(token),
        now,
        now,
        pairing.scopes_json,
        relayIdentity?.publicKey ?? null,
        relayIdentity?.fingerprint ?? null,
      );
      return {
        token,
        device: {
          id,
          name,
          createdAt: now,
          lastSeenAt: now,
          scopes,
          ...(relayIdentity ? { relayIdentityFingerprint: relayIdentity.fingerprint } : {}),
        },
      };
    },
  );

  const claimRelay = db.transaction(
    (
      secretHash: string,
      token: string,
      name: string,
      now: number,
      relayIdentityPublicKey: string,
    ): DeviceEnrollment | undefined => {
      prunePairings.run(now);
      const pairing = findPairing.get(secretHash) as PairingRow | undefined;
      if (
        !pairing?.device_id ||
        !pairing.token_hash ||
        pairing.cancellation_id ||
        pairing.expires_at < now ||
        pairing.token_hash !== digest(token)
      )
        return undefined;
      const scopes = scopesFromJson(pairing.scopes_json);
      const relayIdentity = relayIdentityForClaim(scopes, relayIdentityPublicKey);
      deletePairing.run(secretHash);
      insertDevice.run(
        pairing.device_id,
        name,
        pairing.token_hash,
        now,
        now,
        pairing.scopes_json,
        relayIdentity?.publicKey ?? null,
        relayIdentity?.fingerprint ?? null,
      );
      return {
        token,
        device: {
          id: pairing.device_id,
          name,
          createdAt: now,
          lastSeenAt: now,
          scopes,
          ...(relayIdentity ? { relayIdentityFingerprint: relayIdentity.fingerprint } : {}),
        },
      };
    },
  );

  const beginCloud = db.transaction(
    (input: ReturnType<typeof normalizeCloudEnrollmentInput>, now: number): CloudEnrollmentRow => {
      pruneCloudEnrollmentHistory(now);
      const existing = findCloudEnrollment.get(input.enrollmentId) as CloudEnrollmentRow | undefined;
      if (existing) {
        if (!cloudEnrollmentMatches(existing, input)) throw new CloudDeviceEnrollmentConflictError();
        return existing;
      }
      const tokenHash = digest(input.token);
      const challengeHash = digest(input.challenge);
      if (
        findDeviceById.get(input.deviceId) ||
        findDeviceByToken.get(tokenHash) ||
        findRelayPairingByDevice.get(input.deviceId) ||
        findPairingByToken.get(tokenHash) ||
        findCloudEnrollmentConflict.get(input.deviceId, tokenHash, challengeHash, input.durableRelayCredentialHash)
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      try {
        insertCloudEnrollment.run(
          input.enrollmentId,
          input.deviceId,
          challengeHash,
          tokenHash,
          input.name,
          input.relayIdentityPublicKey,
          input.relayIdentityFingerprint,
          input.durableRelayCredentialHash,
          now,
          now,
        );
      } catch (error) {
        if (
          String((error as Error).message)
            .toLowerCase()
            .includes("unique")
        ) {
          throw new CloudDeviceEnrollmentConflictError();
        }
        throw error;
      }
      return findCloudEnrollment.get(input.enrollmentId) as CloudEnrollmentRow;
    },
  );

  const finalizeCloud = db.transaction(
    (
      enrollmentId: string,
      temporaryCredentialHash: string,
      controlPlaneDeviceId: string,
      now: number,
    ): { enrollment: CloudEnrollmentRow; device: DeviceRow } => {
      const enrollment = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow | undefined;
      if (!enrollment) throw new CloudDeviceEnrollmentConflictError();
      if (enrollment.temporary_credential_hash && enrollment.temporary_credential_hash !== temporaryCredentialHash) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.control_plane_device_id && enrollment.control_plane_device_id !== controlPlaneDeviceId) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.revoked_at !== null && enrollment.revoked_at !== undefined) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      let device = findDeviceById.get(enrollment.device_id) as DeviceRow | undefined;
      if (enrollment.state === "prepared") {
        const tokenDevice = findDeviceByToken.get(enrollment.token_hash) as DeviceRow | undefined;
        if (
          (tokenDevice && tokenDevice.id !== enrollment.device_id) ||
          (device &&
            (device.token_hash !== enrollment.token_hash ||
              device.name !== enrollment.name ||
              device.scopes_json !== JSON.stringify(["relay"]) ||
              device.relay_public_key !== enrollment.relay_public_key ||
              device.relay_fingerprint !== enrollment.relay_fingerprint))
        ) {
          throw new CloudDeviceEnrollmentConflictError();
        }
        if (!device) {
          insertDevice.run(
            enrollment.device_id,
            enrollment.name,
            enrollment.token_hash,
            now,
            now,
            JSON.stringify(["relay"] satisfies DeviceScope[]),
            enrollment.relay_public_key,
            enrollment.relay_fingerprint,
          );
          device = findDeviceById.get(enrollment.device_id) as DeviceRow;
        }
        if (
          finalizeCloudEnrollment.run(temporaryCredentialHash, controlPlaneDeviceId, now, enrollmentId).changes !== 1
        ) {
          throw new CloudDeviceEnrollmentConflictError();
        }
      }
      const updated = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow;
      if (
        !updated.temporary_credential_hash ||
        updated.temporary_credential_hash !== temporaryCredentialHash ||
        updated.control_plane_device_id !== controlPlaneDeviceId
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (!device) device = findDeviceById.get(updated.device_id) as DeviceRow | undefined;
      if (!device) throw new CloudDeviceEnrollmentConflictError();
      return { enrollment: updated, device };
    },
  );

  const markCloudPromoted = db.transaction(
    (
      enrollmentId: string,
      expectedCredentialHash: string,
      credentialHash: string,
      now: number,
    ): { enrollment: CloudEnrollmentRow; device: DeviceRow } => {
      const enrollment = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow | undefined;
      if (
        !enrollment ||
        enrollment.state === "prepared" ||
        (enrollment.revoked_at !== null && enrollment.revoked_at !== undefined) ||
        !enrollment.control_plane_device_id ||
        enrollment.temporary_credential_hash !== expectedCredentialHash ||
        enrollment.durable_credential_hash !== credentialHash
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (
        enrollment.state === "local-finalized" &&
        (enrollment.broker_promoted_at === null || enrollment.broker_promoted_at === undefined)
      ) {
        if (
          markCloudEnrollmentPromoted.run(now, now, enrollmentId, expectedCredentialHash, credentialHash).changes !== 1
        ) {
          throw new CloudDeviceEnrollmentConflictError();
        }
      }
      const updated = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow;
      const device = findDeviceById.get(updated.device_id) as DeviceRow | undefined;
      if (updated.broker_promoted_at === null || updated.broker_promoted_at === undefined || !device) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      return { enrollment: updated, device };
    },
  );

  const completeCloud = db.transaction(
    (
      enrollmentId: string,
      expectedCredentialHash: string,
      credentialHash: string,
      now: number,
    ): { enrollment: CloudEnrollmentRow; device: DeviceRow } => {
      const enrollment = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow | undefined;
      if (
        !enrollment ||
        enrollment.state === "prepared" ||
        (enrollment.revoked_at !== null && enrollment.revoked_at !== undefined) ||
        enrollment.broker_promoted_at === null ||
        enrollment.broker_promoted_at === undefined ||
        enrollment.temporary_credential_hash !== expectedCredentialHash ||
        enrollment.durable_credential_hash !== credentialHash
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.state === "local-finalized") {
        if (completeCloudEnrollment.run(now, enrollmentId, expectedCredentialHash, credentialHash).changes !== 1) {
          throw new CloudDeviceEnrollmentConflictError();
        }
      }
      const updated = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow;
      const device = findDeviceById.get(updated.device_id) as DeviceRow | undefined;
      if (!device) throw new CloudDeviceEnrollmentConflictError();
      return { enrollment: updated, device };
    },
  );

  const revokeCloud = db.transaction(
    (
      enrollmentId: string,
      controlPlaneDeviceId: string,
      expectedCredentialHash: string,
      credentialHash: string,
      now: number,
    ): CloudEnrollmentRow => {
      const enrollment = findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow | undefined;
      if (
        !enrollment ||
        enrollment.state === "prepared" ||
        enrollment.control_plane_device_id !== controlPlaneDeviceId ||
        enrollment.temporary_credential_hash !== expectedCredentialHash ||
        enrollment.durable_credential_hash !== credentialHash
      ) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      if (enrollment.revoked_at === null || enrollment.revoked_at === undefined) {
        if (
          revokeCloudEnrollment.run(
            now,
            now,
            enrollmentId,
            controlPlaneDeviceId,
            expectedCredentialHash,
            credentialHash,
          ).changes !== 1
        ) {
          throw new CloudDeviceEnrollmentConflictError();
        }
        revokeDevice.run(enrollment.device_id);
      }
      return findCloudEnrollment.get(enrollmentId) as CloudEnrollmentRow;
    },
  );

  const revokeById = db.transaction((deviceId: string, now: number): boolean => {
    if (!findDeviceById.get(deviceId)) return false;
    tombstoneCloudEnrollmentByDevice.run(now, now, deviceId);
    return revokeDevice.run(deviceId).changes === 1;
  });

  const revokeAll = db.transaction((now: number): number => {
    tombstoneAllCloudEnrollments.run(now, now);
    return revokeAllDevices.run().changes;
  });

  return {
    mode: "sqlite",
    issuePairing(now = Date.now(), rawScopes = ["direct"]) {
      const scopes = normalizeDeviceScopes(rawScopes);
      if (!scopes) throw new Error("invalid device scopes");
      prunePairings.run(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        try {
          const expiresAt = now + PAIRING_TTL_MS;
          insertPairing.run(digest(secret), now, expiresAt, JSON.stringify(scopes));
          return { secret, expiresAt, scopes: [...scopes] };
        } catch (error) {
          // Only a generator collision is retryable. A real SQLite failure should stay loud.
          if (
            !String((error as Error).message)
              .toLowerCase()
              .includes("unique")
          )
            throw error;
        }
      }
      throw new Error("could not allocate a unique pairing credential");
    },
    cancelPairing: (secret) => cancelPairing.run(digest(secret)).changes > 0,
    claimPairing(secret, rawName, now = Date.now(), relayIdentityPublicKey) {
      const name = normalizeDeviceName(rawName);
      if (!name) return undefined;
      return claim(digest(secret), name, now, generateToken(), generateId(), relayIdentityPublicKey);
    },
    issueRelayPairing(now = Date.now()) {
      prunePairings.run(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const secret = generateSecret();
        const token = generateToken();
        const deviceId = generateId();
        const expiresAt = now + PAIRING_TTL_MS;
        try {
          insertRelayPairing.run(
            digest(secret),
            now,
            expiresAt,
            JSON.stringify(["relay"] satisfies DeviceScope[]),
            deviceId,
            digest(token),
          );
          return { secret, expiresAt, scopes: ["relay"], deviceId, token };
        } catch (error) {
          if (
            !String((error as Error).message)
              .toLowerCase()
              .includes("unique")
          )
            throw error;
        }
      }
      throw new Error("could not allocate a unique relay pairing credential");
    },
    pendingRelayPairing(deviceId, now = Date.now()) {
      prunePairings.run(now);
      return findPendingRelayPairing.get(deviceId, now) !== undefined;
    },
    beginRelayPairingCancellation(deviceId, now = Date.now()) {
      prunePairings.run(now);
      const pairing = findRelayPairingByDevice.get(deviceId) as PairingRow | undefined;
      if (!pairing || pairing.expires_at < now) return { status: "missing" };
      if (pairing.cancellation_id) return { status: "busy" };
      const reservation = { deviceId, reservationId: randomUUID() };
      if (reserveRelayPairingCancellation.run(reservation.reservationId, deviceId).changes !== 1) {
        return findRelayPairingByDevice.get(deviceId) ? { status: "busy" } : { status: "missing" };
      }
      return { status: "reserved", reservation };
    },
    releaseRelayPairingCancellation: (reservation) =>
      releaseRelayPairingCancellation.run(reservation.deviceId, reservation.reservationId).changes === 1,
    finishRelayPairingCancellation: (reservation) =>
      finishRelayPairingCancellation.run(reservation.deviceId, reservation.reservationId).changes === 1,
    cancelRelayPairing: (deviceId) => cancelRelayPairing.run(deviceId).changes > 0,
    claimRelayPairing(secret, token, rawName, relayIdentityPublicKey, now = Date.now()) {
      const name = normalizeDeviceName(rawName);
      if (!name || !/^rcd_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      return claimRelay(digest(secret), token, name, now, relayIdentityPublicKey);
    },
    authenticate(token, now = Date.now(), requiredScope = "direct") {
      const row = findDeviceByToken.get(digest(token)) as DeviceRow | undefined;
      if (!row) return undefined;
      if (!scopesFromJson(row.scopes_json).includes(requiredScope)) return undefined;
      if (requiredScope === "relay" && findPendingCloudEnrollmentByDevice.get(row.id)) return undefined;
      if (now - row.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
        touchDevice.run(now, row.id);
        row.last_seen_at = now;
      }
      return rowToDevice(row);
    },
    relayIdentity: (id) => relayIdentityFromRow(findDeviceById.get(id) as DeviceRow | undefined),
    beginCloudDeviceEnrollment(rawInput, now = Date.now()) {
      let input: ReturnType<typeof normalizeCloudEnrollmentInput>;
      try {
        input = normalizeCloudEnrollmentInput(rawInput);
      } catch {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const enrollment = beginCloud(input, now);
      const device = findDeviceById.get(enrollment.device_id) as DeviceRow | undefined;
      return cloudProgress(enrollment, device ? rowToDevice(device) : undefined);
    },
    finalizeCloudDeviceEnrollment(enrollmentId, temporaryRelayCredentialHash, controlPlaneDeviceId, now = Date.now()) {
      if (!UUID.test(enrollmentId) || !UUID.test(controlPlaneDeviceId)) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const temporaryHash = safeCloudCredentialHash(temporaryRelayCredentialHash);
      const result = finalizeCloud(enrollmentId, temporaryHash, controlPlaneDeviceId, now);
      return cloudProgress(result.enrollment, rowToDevice(result.device));
    },
    markCloudDeviceEnrollmentPromoted(enrollmentId, expectedCredentialHash, credentialHash, now = Date.now()) {
      if (!UUID.test(enrollmentId)) throw new CloudDeviceEnrollmentConflictError();
      const expectedHash = safeCloudCredentialHash(expectedCredentialHash);
      const durableHash = safeCloudCredentialHash(credentialHash);
      const result = markCloudPromoted(enrollmentId, expectedHash, durableHash, now);
      return cloudProgress(result.enrollment, rowToDevice(result.device));
    },
    completeCloudDeviceEnrollment(enrollmentId, expectedCredentialHash, credentialHash, now = Date.now()) {
      if (!UUID.test(enrollmentId)) throw new CloudDeviceEnrollmentConflictError();
      const expectedHash = safeCloudCredentialHash(expectedCredentialHash);
      const durableHash = safeCloudCredentialHash(credentialHash);
      const result = completeCloud(enrollmentId, expectedHash, durableHash, now);
      return cloudProgress(result.enrollment, rowToDevice(result.device));
    },
    revokeCloudDeviceEnrollment(
      enrollmentId,
      controlPlaneDeviceId,
      expectedCredentialHash,
      credentialHash,
      now = Date.now(),
    ) {
      if (!UUID.test(enrollmentId) || !UUID.test(controlPlaneDeviceId)) {
        throw new CloudDeviceEnrollmentConflictError();
      }
      const expectedHash = safeCloudCredentialHash(expectedCredentialHash);
      const durableHash = safeCloudCredentialHash(credentialHash);
      return cloudProgress(revokeCloud(enrollmentId, controlPlaneDeviceId, expectedHash, durableHash, now));
    },
    cloudDeviceEnrollmentPending(deviceId) {
      if (!SAFE_IDENTIFIER.test(deviceId)) return false;
      return findPendingCloudEnrollmentByDevice.get(deviceId) !== undefined;
    },
    pendingCloudDevicePromotions(now = Date.now(), limit = 25) {
      pruneCloudEnrollmentHistory(now);
      return (listPendingCloudPromotions.all(safeCloudPromotionLimit(limit)) as CloudEnrollmentRow[]).map(
        (enrollment) => ({
          enrollmentId: enrollment.enrollment_id,
          deviceId: enrollment.device_id,
          expectedCredentialHash: enrollment.temporary_credential_hash!,
          credentialHash: enrollment.durable_credential_hash,
          controlPlaneDeviceId: enrollment.control_plane_device_id!,
          brokerPromoted: enrollment.broker_promoted_at !== null && enrollment.broker_promoted_at !== undefined,
        }),
      );
    },
    deferCloudDevicePromotion(enrollmentId, expectedCredentialHash, credentialHash, now = Date.now()) {
      if (!UUID.test(enrollmentId)) return false;
      let expectedHash: string;
      let durableHash: string;
      try {
        expectedHash = safeCloudCredentialHash(expectedCredentialHash);
        durableHash = safeCloudCredentialHash(credentialHash);
      } catch {
        return false;
      }
      return deferCloudPromotion.run(now, enrollmentId, expectedHash, durableHash).changes === 1;
    },
    list: () => (listDevices.all() as DeviceRow[]).map(rowToDevice),
    rename(id, rawName) {
      const name = normalizeDeviceName(rawName);
      if (!name || renameDevice.run(name, id).changes === 0) return undefined;
      const row = findDeviceById.get(id) as DeviceRow;
      return rowToDevice(row);
    },
    revoke: (id) => revokeById(id, Date.now()),
    revokeAll: () => revokeAll(Date.now()),
    close: () => db.close(),
  };
}
