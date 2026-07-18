import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  SignedCloudAuthorizationSnapshotSchema,
  CLOUD_AUTHORIZATION_MAX_SNAPSHOT_AGE_MS,
  verifySignedCloudAuthorizationSnapshot,
  type CloudAuthorizationPermission,
  type CloudAuthorizationSnapshot,
  type CloudAuthorizationTrustedKey,
  type SignedCloudAuthorizationSnapshot,
} from "./cloud-contract.js";
import { ensureDataDir } from "./data-dir.js";
import type { TeamAuthorizationResource } from "./team-store.js";

export const CLOUD_AUTHORIZATION_FILE = "cloud-authorization.json";
export const CLOUD_AUTHORIZATION_LAST_GOOD_FILE = "cloud-authorization.last-good.json";
export const CLOUD_AUTHORIZATION_CLOCK_SKEW_MS = 5 * 60_000;

const MAX_AUTHORIZATION_FILE_BYTES = 16 * 1024 * 1024;
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PersistedAuthorizationSchema = z
  .object({
    formatVersion: z.literal(1),
    acceptedAt: TimestampSchema,
    envelope: SignedCloudAuthorizationSnapshotSchema,
  })
  .strict();

export type CloudAuthorizationSnapshotStatus = "unavailable" | "pending" | "active" | "expired";
export type CloudAuthorizationPrincipalType = "device" | "relay";
export type CloudAuthorizationStoreErrorCode =
  | "TARGET_MISMATCH"
  | "CONTRACT_MISMATCH"
  | "REPLAY"
  | "TEMPORAL_REGRESSION"
  | "ISSUED_IN_FUTURE"
  | "ISSUED_TOO_OLD"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "PERSISTENCE_CORRUPT"
  | "PERSISTENCE_UNSAFE"
  | "REVISION_CONFLICT";

export class CloudAuthorizationStoreError extends Error {
  constructor(
    readonly code: CloudAuthorizationStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudAuthorizationStoreError";
  }
}

export interface StoredCloudAuthorizationSnapshot {
  acceptedAt: number;
  envelope: SignedCloudAuthorizationSnapshot;
  snapshot: CloudAuthorizationSnapshot;
}

export interface CloudAuthorizationState {
  status: CloudAuthorizationSnapshotStatus;
  revision?: number;
  notBefore?: number;
  expiresAt?: number;
}

export interface CloudAuthorizationDecision {
  allowed: boolean;
  reason:
    | "cloud-grant"
    | "cloud-authorization-unavailable"
    | "cloud-authorization-pending"
    | "cloud-authorization-expired"
    | "cloud-principal-unbound"
    | "cloud-missing-permission"
    | "cloud-host-mismatch";
  revision?: number;
}

export interface OpenCloudAuthorizationStoreOptions {
  dataDir: string;
  organizationId: string;
  hostId: string;
  trustedKeys: readonly CloudAuthorizationTrustedKey[] | (() => readonly CloudAuthorizationTrustedKey[]);
  /** Provisioned authorization contract. An envelope from another version is never accepted as a downgrade. */
  authorizationVersion?: 1 | 2;
  now?: () => number;
  clockSkewMs?: number;
}

export interface CloudAuthorizationStore {
  readonly path: string;
  readonly backupPath: string;
  getLastKnownGood(): StoredCloudAuthorizationSnapshot | undefined;
  getState(now?: number): CloudAuthorizationState;
  getActiveSnapshot(now?: number): CloudAuthorizationSnapshot | undefined;
  apply(value: unknown, now?: number): StoredCloudAuthorizationSnapshot;
  reload(): StoredCloudAuthorizationSnapshot | undefined;
  authorize(
    actorType: CloudAuthorizationPrincipalType,
    actorId: string,
    permission: CloudAuthorizationPermission,
    resource?: TeamAuthorizationResource,
    now?: number,
  ): CloudAuthorizationDecision;
}

interface PersistedAuthorization {
  formatVersion: 1;
  acceptedAt: number;
  envelope: SignedCloudAuthorizationSnapshot;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function existingFile(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertSafeFile(path: string): ReturnType<typeof lstatSync> | undefined {
  let stat;
  try {
    stat = existingFile(path);
  } catch {
    throw new CloudAuthorizationStoreError("PERSISTENCE_UNSAFE", "cloud authorization state could not be inspected");
  }
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CloudAuthorizationStoreError(
      "PERSISTENCE_UNSAFE",
      "cloud authorization state path must be a regular file",
    );
  }
  if (stat.size > MAX_AUTHORIZATION_FILE_BYTES) {
    throw new CloudAuthorizationStoreError("PERSISTENCE_CORRUPT", "cloud authorization state is too large");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CloudAuthorizationStoreError(
      "PERSISTENCE_UNSAFE",
      "cloud authorization state must be owned by the current user",
    );
  }
  return stat;
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && !(process.platform === "win32" && code === "EPERM")) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readPersisted(path: string): PersistedAuthorization | undefined {
  const before = assertSafeFile(path);
  if (!before) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_AUTHORIZATION_FILE_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new CloudAuthorizationStoreError(
        "PERSISTENCE_UNSAFE",
        "cloud authorization state changed while it was being opened",
      );
    }
    fchmodSync(descriptor, 0o600);
    const parsed = PersistedAuthorizationSchema.safeParse(JSON.parse(readFileSync(descriptor, "utf8")));
    if (!parsed.success) {
      throw new CloudAuthorizationStoreError("PERSISTENCE_CORRUPT", "cloud authorization state is corrupt");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CloudAuthorizationStoreError) throw error;
    throw new CloudAuthorizationStoreError("PERSISTENCE_CORRUPT", "cloud authorization state is corrupt");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameDocument(left: PersistedAuthorization, right: PersistedAuthorization): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writePersisted(path: string, document: PersistedAuthorization): void {
  assertSafeFile(path);
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTHORIZATION_FILE_BYTES) {
    throw new CloudAuthorizationStoreError("PERSISTENCE_CORRUPT", "cloud authorization state is too large");
  }
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try {
      fsyncDirectory(dirname(path));
    } catch (error) {
      let visible: PersistedAuthorization | undefined;
      try {
        visible = readPersisted(path);
      } catch {
        /* Preserve the durability error below. */
      }
      if (!visible || !sameDocument(visible, document)) throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}

function stored(record: PersistedAuthorization): StoredCloudAuthorizationSnapshot {
  return {
    acceptedAt: record.acceptedAt,
    envelope: clone(record.envelope),
    snapshot: clone(record.envelope.snapshot),
  };
}

function stateFor(record: StoredCloudAuthorizationSnapshot | undefined, now: number): CloudAuthorizationState {
  if (!record) return { status: "unavailable" };
  const snapshot = record.snapshot;
  const common = { revision: snapshot.revision, notBefore: snapshot.notBefore, expiresAt: snapshot.expiresAt };
  if (now < snapshot.notBefore) return { status: "pending", ...common };
  if (now >= snapshot.expiresAt) return { status: "expired", ...common };
  return { status: "active", ...common };
}

function scopeMatches(
  snapshot: CloudAuthorizationSnapshot,
  scope: CloudAuthorizationSnapshot["grants"][number]["scope"],
  resource: TeamAuthorizationResource | undefined,
): boolean {
  if (scope.type === "organization") return true;
  if (scope.type === "host") {
    return scope.id === snapshot.hostId && (resource?.hostId === undefined || resource.hostId === scope.id);
  }
  return resource?.workspaceId === scope.id;
}

class FileCloudAuthorizationStore implements CloudAuthorizationStore {
  readonly path: string;
  readonly backupPath: string;
  private current: StoredCloudAuthorizationSnapshot | undefined;
  private readonly now: () => number;
  private readonly clockSkewMs: number;

  constructor(private readonly options: OpenCloudAuthorizationStoreOptions) {
    this.path = join(options.dataDir, CLOUD_AUTHORIZATION_FILE);
    this.backupPath = join(options.dataDir, CLOUD_AUTHORIZATION_LAST_GOOD_FILE);
    this.now = options.now ?? Date.now;
    this.clockSkewMs = options.clockSkewMs ?? CLOUD_AUTHORIZATION_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(this.clockSkewMs) || this.clockSkewMs < 0) {
      throw new Error("invalid cloud authorization clock skew");
    }
  }

  private trustedKeys(): readonly CloudAuthorizationTrustedKey[] {
    return typeof this.options.trustedKeys === "function" ? this.options.trustedKeys() : this.options.trustedKeys;
  }

  private validateTarget(envelope: SignedCloudAuthorizationSnapshot): void {
    if (this.options.authorizationVersion !== undefined && envelope.v !== this.options.authorizationVersion) {
      throw new CloudAuthorizationStoreError(
        "CONTRACT_MISMATCH",
        "cloud authorization snapshot does not match the provisioned contract version",
      );
    }
    if (
      envelope.snapshot.organizationId !== this.options.organizationId ||
      envelope.snapshot.hostId !== this.options.hostId
    ) {
      throw new CloudAuthorizationStoreError(
        "TARGET_MISMATCH",
        "cloud authorization snapshot targets a different organization or host",
      );
    }
  }

  private verifyPersisted(record: PersistedAuthorization): StoredCloudAuthorizationSnapshot {
    const envelope = verifySignedCloudAuthorizationSnapshot(record.envelope, this.trustedKeys(), record.acceptedAt);
    this.validateTarget(envelope);
    return stored({ ...record, envelope });
  }

  getLastKnownGood(): StoredCloudAuthorizationSnapshot | undefined {
    return this.current ? clone(this.current) : undefined;
  }

  getState(now = this.now()): CloudAuthorizationState {
    return stateFor(this.current, now);
  }

  getActiveSnapshot(now = this.now()): CloudAuthorizationSnapshot | undefined {
    return this.getState(now).status === "active" && this.current ? clone(this.current.snapshot) : undefined;
  }

  apply(value: unknown, now = this.now()): StoredCloudAuthorizationSnapshot {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid cloud authorization acceptance time");
    const envelope = verifySignedCloudAuthorizationSnapshot(value, this.trustedKeys(), now);
    this.validateTarget(envelope);
    const snapshot = envelope.snapshot;
    const previous = this.current?.snapshot;
    if (previous && snapshot.revision <= previous.revision) {
      throw new CloudAuthorizationStoreError("REPLAY", "cloud authorization snapshot revision was already observed");
    }
    if (previous && snapshot.issuedAt < previous.issuedAt) {
      throw new CloudAuthorizationStoreError("TEMPORAL_REGRESSION", "cloud authorization issue time moved backwards");
    }
    if (snapshot.issuedAt > now + this.clockSkewMs) {
      throw new CloudAuthorizationStoreError(
        "ISSUED_IN_FUTURE",
        "cloud authorization snapshot issue time is in the future",
      );
    }
    if (snapshot.issuedAt < now - CLOUD_AUTHORIZATION_MAX_SNAPSHOT_AGE_MS) {
      throw new CloudAuthorizationStoreError(
        "ISSUED_TOO_OLD",
        "cloud authorization snapshot issue time is outside the accepted age window",
      );
    }
    if (snapshot.notBefore > now + this.clockSkewMs) {
      throw new CloudAuthorizationStoreError("NOT_YET_VALID", "cloud authorization snapshot is not active yet");
    }
    if (snapshot.expiresAt <= now) {
      throw new CloudAuthorizationStoreError("EXPIRED", "cloud authorization snapshot has expired");
    }

    const persisted: PersistedAuthorization = { formatVersion: 1, acceptedAt: now, envelope };
    // Keep two independently atomic copies of the newest accepted revision. Retaining the previous revision as the
    // backup would let a corrupt primary file lower the replay floor after restart and could restore revoked grants.
    // Writing the mirror first also leaves at least one newest-revision copy if the process stops between renames.
    writePersisted(this.backupPath, persisted);
    writePersisted(this.path, persisted);
    this.current = stored(persisted);
    return clone(this.current);
  }

  reload(): StoredCloudAuthorizationSnapshot | undefined {
    const candidates: StoredCloudAuthorizationSnapshot[] = [];
    const errors: unknown[] = [];
    for (const path of [this.path, this.backupPath]) {
      let record: PersistedAuthorization | undefined;
      try {
        record = readPersisted(path);
        if (record) candidates.push(this.verifyPersisted(record));
      } catch (error) {
        if (error instanceof CloudAuthorizationStoreError && error.code === "PERSISTENCE_UNSAFE") throw error;
        errors.push(error);
      }
    }
    if (candidates.length === 0) {
      if (errors.length > 0) {
        throw new CloudAuthorizationStoreError(
          "PERSISTENCE_CORRUPT",
          "no valid last-known-good cloud authorization snapshot could be loaded",
        );
      }
      return this.current ? clone(this.current) : undefined;
    }

    candidates.sort((left, right) => right.snapshot.revision - left.snapshot.revision);
    const selected = candidates[0]!;
    const sameRevision = candidates.find(
      (candidate) =>
        candidate !== selected &&
        candidate.snapshot.revision === selected.snapshot.revision &&
        JSON.stringify(candidate.envelope) !== JSON.stringify(selected.envelope),
    );
    if (sameRevision) {
      throw new CloudAuthorizationStoreError(
        "REVISION_CONFLICT",
        "different cloud authorization snapshots use the same revision",
      );
    }
    if (this.current && selected.snapshot.revision < this.current.snapshot.revision) {
      throw new CloudAuthorizationStoreError("REPLAY", "cloud authorization reload would reduce the revision");
    }
    if (
      this.current &&
      selected.snapshot.revision === this.current.snapshot.revision &&
      JSON.stringify(selected.envelope) !== JSON.stringify(this.current.envelope)
    ) {
      throw new CloudAuthorizationStoreError(
        "REVISION_CONFLICT",
        "cloud authorization reload conflicts with the accepted revision",
      );
    }
    if (!this.current || selected.snapshot.revision > this.current.snapshot.revision) this.current = clone(selected);
    return clone(this.current);
  }

  authorize(
    actorType: CloudAuthorizationPrincipalType,
    actorId: string,
    permission: CloudAuthorizationPermission,
    resource?: TeamAuthorizationResource,
    now = this.now(),
  ): CloudAuthorizationDecision {
    const state = this.getState(now);
    if (state.status === "unavailable") return { allowed: false, reason: "cloud-authorization-unavailable" };
    if (state.status === "pending") {
      return { allowed: false, reason: "cloud-authorization-pending", revision: state.revision };
    }
    if (state.status === "expired") {
      return { allowed: false, reason: "cloud-authorization-expired", revision: state.revision };
    }
    const snapshot = this.current!.snapshot;
    // A managed browser is routed to one target host by the control plane. This runtime authorizes only that local
    // host's resources; organization-wide multi-host navigation selects another host/runtime instead of tunnelling
    // peer-host resources through this snapshot.
    if (resource?.hostId !== undefined && resource.hostId !== snapshot.hostId) {
      return { allowed: false, reason: "cloud-host-mismatch", revision: snapshot.revision };
    }
    const principalGrants = snapshot.grants.filter(
      (grant) => grant.principalType === actorType && grant.principalId === actorId,
    );
    if (principalGrants.length === 0) {
      return { allowed: false, reason: "cloud-principal-unbound", revision: snapshot.revision };
    }
    const allowed = principalGrants.some(
      (grant) => grant.permissions.includes(permission) && scopeMatches(snapshot, grant.scope, resource),
    );
    return {
      allowed,
      reason: allowed ? "cloud-grant" : "cloud-missing-permission",
      revision: snapshot.revision,
    };
  }
}

export function openCloudAuthorizationStore(options: OpenCloudAuthorizationStoreOptions): CloudAuthorizationStore {
  ensureDataDir(options.dataDir);
  const store = new FileCloudAuthorizationStore(options);
  store.reload();
  return store;
}
