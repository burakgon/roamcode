import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  buildRelayPairingUrl,
  CloudHostConfigSchema,
  cloudHostConfigPath,
  createRelayDeviceProvisioner,
  generateRelayAccountCredential,
  generateRelayCredential,
  loadOrCreateRelayIdentity,
  normalizeRelayAppUrl,
  openDeviceStore,
  readRelayHostConfig,
  readCloudHostConfig,
  readServiceRecord,
  relayAccountCredentialHash,
  relayAccountCredentialLookup,
  relayCredentialHash,
  removeRelayHostConfig,
  removeCloudHostConfig,
  resolveRelayHostConfig,
  resolveDataDir,
  restartService,
  writeRelayHostConfig,
  writeCloudHostConfig,
  type CloudHostConfig,
  type PersistedRelayHostConfig,
  type RelayPairingPackage,
  type RelayHostConfigInput,
  type ServiceRecord,
} from "@roamcode.ai/server";
import type { CliOptions } from "./args.js";
import {
  getCloudAccessSession,
  type BrowserOpener,
  type CloudAuthCommandOptions,
  type CloudCredentialStore,
  type DetachedProcessRunner,
  type ProcessRunner,
} from "./cloud-auth.js";
import { renderTerminalQr } from "./pair.js";

export const CLOUD_ACTIONS = [
  "login",
  "logout",
  "whoami",
  "connect",
  "configure",
  "pair",
  "status",
  "rotate",
  "disconnect",
  "account-create",
  "account-list",
  "account-update",
  "account-rotate",
  "account-recover",
  "account-delete",
] as const;
type CloudAction = (typeof CLOUD_ACTIONS)[number];
type CloudAccountAction = Extract<CloudAction, `account-${string}`>;

const DEFAULT_CLOUD_URL = "https://relay.roamcode.ai";
const DEFAULT_CLOUD_APP_URL = "https://roamcode.ai";
const MANAGED_CLOUD_OPERATION_FILE = "cloud-host-operation.json";
const MAX_MANAGED_OPERATION_BYTES = 32 * 1_024;
const MAX_CREDENTIAL_FILE_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_HOST_CREDENTIAL = /^rch_[A-Za-z0-9_-]{64}$/;
const RELAY_HOST_CREDENTIAL = /^rrh_[A-Za-z0-9_-]{43}$/;

class CloudUsageError extends Error {}

class CloudOperationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface RestartResult {
  ok: boolean;
  error?: string;
}

export interface CloudCommandOptions {
  options: CliOptions;
  env: NodeJS.ProcessEnv;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  dataDir?: string;
  generateRouteId?: () => string;
  generateHostCredential?: () => string;
  generateCloudHostCredential?: () => string;
  generateHostId?: () => string;
  generateOperationId?: () => string;
  generateDeviceCredential?: () => string;
  generateAccountCredential?: () => string;
  readConfig?: (dataDir: string) => PersistedRelayHostConfig | undefined;
  writeConfig?: (dataDir: string, input: RelayHostConfigInput) => PersistedRelayHostConfig;
  removeConfig?: (dataDir: string) => boolean;
  readCloudHostConfig?: (path: string) => CloudHostConfig | undefined;
  writeCloudHostConfig?: (path: string, input: unknown) => CloudHostConfig;
  removeCloudHostConfig?: (path: string) => boolean;
  readInstalledService?: (dataDir: string) => ServiceRecord | undefined;
  restartInstalledService?: (record: ServiceRecord) => RestartResult;
  /** Isolated cloud-account auth seams; tests never touch a browser, Keychain, or the real clock. */
  authCredentialStore?: CloudCredentialStore;
  openBrowser?: BrowserOpener;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
  processRunner?: ProcessRunner;
  detachedProcessRunner?: DetachedProcessRunner;
  uid?: number;
  pid?: number;
  randomId?: () => string;
}

interface CloudRouteResponse {
  route: { id: string };
}

interface CloudRouteStatus {
  routeId: string;
  hostOnline: boolean;
  activeDevices: number;
}

interface CloudAccountRecord {
  id: string;
  label: string;
  status: "active" | "suspended" | "deleted";
  plan: "free" | "team" | "enterprise";
  maxRoutes: number;
  maxDevicesPerRoute: number;
  revision: number;
}

interface ManagedCloudIdentity {
  organizationId: string;
}

interface ManagedCloudProvisioningResponse {
  hostConfig: CloudHostConfig;
  relayConfig: Omit<RelayHostConfigInput, "hostCredential">;
}

interface ManagedCloudOperation {
  version: 1;
  kind: "managed-cloud-host-operation";
  action: "connect" | "rotate";
  controlPlaneOrigin: string;
  organizationId: string;
  hostId: string;
  operationId: string;
  label: string;
  slug: string;
  cloudHostCredential: string;
  relayHostCredential: string;
  createdAt: number;
}

interface StagedCredentialFile {
  outputPath: string;
  pendingPath: string;
  replaceExisting: boolean;
  pendingIdentity: { dev: number; ino: number };
  pendingFingerprint: string;
  outputIdentity?: { dev: number; ino: number };
  outputFingerprint?: string;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function cloudOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CloudUsageError("cloud relay URL must be a valid HTTPS origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new CloudUsageError(
      "cloud relay URL must be an HTTPS origin without credentials, a path, query, or fragment",
    );
  }
  return url.origin;
}

function cloudAppOrigin(raw: string): string {
  try {
    return normalizeRelayAppUrl(raw);
  } catch {
    throw new CloudUsageError(
      "cloud app URL must be an HTTPS origin without credentials, a path, query, or fragment (loopback HTTP is allowed)",
    );
  }
}

function apiOriginForRelay(config: { relayUrl: string }): string {
  let url: URL;
  try {
    url = new URL(config.relayUrl);
  } catch {
    throw new CloudOperationError("saved cloud configuration contains an invalid relay URL");
  }
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  if (url.pathname.replace(/\/$/, "") === "/v1/connect") url.pathname = "/";
  try {
    return cloudOrigin(url.toString());
  } catch {
    throw new CloudOperationError("saved cloud configuration does not point to a secure relay origin");
  }
}

function safeLabel(raw: string | undefined): string {
  const label = (raw ?? "RoamCode host").trim().replace(/\s+/g, " ");
  if (!label || label.length > 80 || UNSAFE_TERMINAL_TEXT.test(label)) {
    throw new CloudUsageError("cloud host label must be 1-80 printable characters");
  }
  return label;
}

function managedHostSlug(label: string, hostId: string): string {
  const prefix = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix || "node"}-${hostId.replaceAll("-", "").slice(0, 8)}`;
}

function managedOperationPath(dataDir: string): string {
  return join(dataDir, MANAGED_CLOUD_OPERATION_FILE);
}

function parseManagedOperation(value: unknown): ManagedCloudOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("saved cloud host operation is invalid");
  }
  const operation = value as Record<string, unknown>;
  const keys = [
    "version",
    "kind",
    "action",
    "controlPlaneOrigin",
    "organizationId",
    "hostId",
    "operationId",
    "label",
    "slug",
    "cloudHostCredential",
    "relayHostCredential",
    "createdAt",
  ];
  if (Object.keys(operation).some((key) => !keys.includes(key))) {
    throw new CloudOperationError("saved cloud host operation is invalid");
  }
  if (
    operation.version !== 1 ||
    operation.kind !== "managed-cloud-host-operation" ||
    (operation.action !== "connect" && operation.action !== "rotate") ||
    typeof operation.controlPlaneOrigin !== "string" ||
    typeof operation.organizationId !== "string" ||
    !UUID.test(operation.organizationId) ||
    typeof operation.hostId !== "string" ||
    !UUID.test(operation.hostId) ||
    typeof operation.operationId !== "string" ||
    !UUID.test(operation.operationId) ||
    typeof operation.label !== "string" ||
    safeLabel(operation.label) !== operation.label ||
    typeof operation.slug !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(operation.slug) ||
    typeof operation.cloudHostCredential !== "string" ||
    !CLOUD_HOST_CREDENTIAL.test(operation.cloudHostCredential) ||
    typeof operation.relayHostCredential !== "string" ||
    !RELAY_HOST_CREDENTIAL.test(operation.relayHostCredential) ||
    !Number.isSafeInteger(operation.createdAt) ||
    (operation.createdAt as number) < 1
  ) {
    throw new CloudOperationError("saved cloud host operation is invalid");
  }
  let controlPlaneOrigin: string;
  try {
    controlPlaneOrigin = cloudOrigin(operation.controlPlaneOrigin);
  } catch {
    throw new CloudOperationError("saved cloud host operation contains an invalid control-plane origin");
  }
  return { ...(operation as unknown as ManagedCloudOperation), controlPlaneOrigin };
}

function readManagedOperation(dataDir: string): ManagedCloudOperation | undefined {
  const path = managedOperationPath(dataDir);
  const before = statOrUndefined(path);
  if (!before) return undefined;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > MAX_MANAGED_OPERATION_BYTES ||
    (Number(before.mode) & 0o077) !== 0 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  ) {
    throw new CloudOperationError("saved cloud host operation is not a private regular file");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      (opened.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new CloudOperationError("saved cloud host operation changed while it was being opened");
    }
    return parseManagedOperation(JSON.parse(readFileSync(descriptor, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof CloudOperationError) throw error;
    throw new CloudOperationError("saved cloud host operation is invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeManagedOperation(dataDir: string, operation: ManagedCloudOperation): ManagedCloudOperation {
  const parsed = parseManagedOperation(operation);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = managedOperationPath(dataDir);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(parsed)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    unlinkSync(temporary);
    fsyncParent(path);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CloudUsageError("another cloud host operation is already pending; rerun its original command");
    }
    throw new CloudOperationError("cloud host operation could not be saved privately");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed or never created */
    }
  }
}

function removeManagedOperation(dataDir: string): void {
  const path = managedOperationPath(dataDir);
  const operation = readManagedOperation(dataDir);
  if (!operation) return;
  try {
    unlinkSync(path);
    fsyncParent(path);
  } catch {
    throw new CloudOperationError(
      "cloud host configuration was committed, but its private recovery operation could not be removed",
    );
  }
}

function cloudAuthInput(
  input: CloudCommandOptions,
  dataDir: string,
  fetchImpl: typeof globalThis.fetch,
): CloudAuthCommandOptions {
  return {
    options: input.options,
    env: input.env,
    dataDir,
    stdout: input.stdout,
    stderr: input.stderr,
    fetch: fetchImpl,
    ...(input.authCredentialStore ? { credentialStore: input.authCredentialStore } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.processRunner ? { processRunner: input.processRunner } : {}),
    ...(input.uid === undefined ? {} : { uid: input.uid }),
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.randomId ? { randomId: input.randomId } : {}),
  };
}

async function managedControlPlaneRequest(
  input: CloudCommandOptions,
  dataDir: string,
  fetchImpl: typeof globalThis.fetch,
  path: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown },
  expectedOrigin?: string,
): Promise<{ origin: string; value: unknown }> {
  const authInput = cloudAuthInput(input, dataDir, fetchImpl);
  const authenticatedRequest = async (forceRefresh: boolean) => {
    let session;
    try {
      session = await getCloudAccessSession(authInput, { forceRefresh });
    } catch (error) {
      const message = error instanceof Error ? error.message : "cloud authentication failed";
      if (/not signed in/i.test(message)) throw new CloudUsageError(message);
      throw new CloudOperationError(message);
    }
    if (expectedOrigin && session.controlPlaneOrigin !== expectedOrigin) {
      throw new CloudUsageError(
        "the pending cloud host operation belongs to a different account service; sign back in there or remove the pending operation explicitly",
      );
    }
    return {
      origin: session.controlPlaneOrigin,
      value: await requestJson(
        fetchImpl,
        session.controlPlaneOrigin,
        path,
        session.accessToken,
        init,
        "cloud control plane",
      ),
    };
  };
  try {
    return await authenticatedRequest(false);
  } catch (error) {
    if (!(error instanceof CloudOperationError) || error.status !== 401) throw error;
    return authenticatedRequest(true);
  }
}

function parseManagedIdentity(value: unknown): ManagedCloudIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud control plane returned an invalid identity response");
  }
  const organization = (value as { organization?: unknown }).organization;
  if (!organization || typeof organization !== "object" || Array.isArray(organization)) {
    throw new CloudUsageError(
      "your cloud login has no Personal or Organization context; approve a context during `roamcode cloud login`",
    );
  }
  const organizationId = (organization as { id?: unknown }).id;
  if (typeof organizationId !== "string" || !UUID.test(organizationId)) {
    throw new CloudOperationError("cloud control plane returned an invalid organization identity");
  }
  return { organizationId };
}

function parseManagedProvisioningResponse(
  value: unknown,
  operation: ManagedCloudOperation,
): ManagedCloudProvisioningResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud control plane returned an invalid host provisioning response");
  }
  const response = value as Record<string, unknown>;
  const host = response.host;
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    throw new CloudOperationError("cloud control plane returned an invalid host record");
  }
  const hostRecord = host as Record<string, unknown>;
  if (hostRecord.id !== operation.hostId || hostRecord.organizationId !== operation.organizationId) {
    throw new CloudOperationError("cloud control plane returned a host for a different owner");
  }
  const parsedHostConfig = CloudHostConfigSchema.safeParse(response.host_config);
  if (
    !parsedHostConfig.success ||
    parsedHostConfig.data.hostId !== operation.hostId ||
    parsedHostConfig.data.organizationId !== operation.organizationId ||
    parsedHostConfig.data.hostCredential !== operation.cloudHostCredential ||
    parsedHostConfig.data.controlPlaneOrigin !== operation.controlPlaneOrigin
  ) {
    throw new CloudOperationError("cloud control plane returned a mismatched host configuration");
  }
  const relay = response.relay_connection;
  if (!relay || typeof relay !== "object" || Array.isArray(relay)) {
    throw new CloudOperationError("cloud control plane did not return the managed relay configuration");
  }
  const relayRecord = relay as Record<string, unknown>;
  if (
    Object.keys(relayRecord).some((key) => !["relay_url", "route_id", "app_url", "host_label"].includes(key)) ||
    relayRecord.route_id !== operation.hostId ||
    relayRecord.host_label !== operation.label ||
    typeof relayRecord.relay_url !== "string" ||
    typeof relayRecord.app_url !== "string"
  ) {
    throw new CloudOperationError("cloud control plane returned an invalid managed relay configuration");
  }
  let relayUrl: string;
  let appUrl: string;
  try {
    relayUrl = cloudOrigin(relayRecord.relay_url);
    appUrl = cloudAppOrigin(relayRecord.app_url);
  } catch {
    throw new CloudOperationError("cloud control plane returned an untrusted managed relay origin");
  }
  return {
    hostConfig: parsedHostConfig.data,
    relayConfig: {
      relayUrl,
      routeId: operation.hostId,
      appUrl,
      hostLabel: operation.label,
    },
  };
}

function assertNoEnvironmentOverride(env: NodeJS.ProcessEnv): void {
  if (env.ROAMCODE_RELAY_URL || env.ROAMCODE_RELAY_ROUTE_ID || env.ROAMCODE_RELAY_HOST_CREDENTIAL) {
    throw new CloudUsageError(
      "ROAMCODE_RELAY_URL/ROUTE_ID/HOST_CREDENTIAL override managed cloud settings; remove them before using this command",
    );
  }
}

function readPrivateCredential(path: string, label: string, pattern: RegExp): string {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new CloudUsageError(`${label} path must be a regular file, not a symlink`);
    }
    if (before.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new CloudUsageError(`${label} file is too large`);
    }
    if ((before.mode & 0o077) !== 0) {
      throw new CloudUsageError(`${label} file must be private (chmod 600)`);
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new CloudUsageError(`${label} file must be owned by the current user`);
    }
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.size > MAX_CREDENTIAL_FILE_BYTES ||
        (opened.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && opened.uid !== process.getuid()) ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        throw new CloudUsageError(`${label} file changed while it was being opened`);
      }
      const credential = readFileSync(descriptor, "utf8").trim();
      if (!pattern.test(credential)) {
        const kind = label === "cloud account credential" ? "account credential" : "root credential";
        throw new CloudUsageError(`${label} file does not contain a valid ${kind}`);
      }
      return credential;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof CloudUsageError) throw error;
    throw new CloudUsageError(`${label} file could not be read securely`);
  }
}

/** Read a bearer credential without following symlinks or accepting group/world-readable files. */
export function readCloudAccountCredential(path: string): string {
  return readPrivateCredential(path, "cloud account credential", /^rrk_[A-Za-z0-9_-]{43}$/);
}

export function readCloudRootCredential(path: string): string {
  return readPrivateCredential(path, "cloud root credential", /^rrp_[A-Za-z0-9_-]{43}$/);
}

function accountCredential(options: CliOptions, env: NodeJS.ProcessEnv): string {
  const path = options.accountTokenFile ?? env.ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE;
  if (!path) {
    throw new CloudUsageError(
      "standalone relay account access requires --account-token-file or ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE",
    );
  }
  return readCloudAccountCredential(path);
}

function rootCredential(options: CliOptions, env: NodeJS.ProcessEnv): string {
  const path = options.rootTokenFile ?? env.ROAMCODE_CLOUD_ROOT_TOKEN_FILE;
  if (!path) {
    throw new CloudUsageError("cloud account operations require --root-token-file or ROAMCODE_CLOUD_ROOT_TOKEN_FILE");
  }
  return readCloudRootCredential(path);
}

function safeAccountId(raw: string | undefined): string {
  if (!raw || !/^rra_[A-Za-z0-9_-]{16,128}$/.test(raw)) {
    throw new CloudUsageError("cloud account operation requires a valid --account-id");
  }
  return raw;
}

function safeAccountLabel(raw: string | undefined, required: boolean): string | undefined {
  if (raw === undefined && !required) return;
  const label = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!label || label.length > 120 || UNSAFE_TERMINAL_TEXT.test(label)) {
    throw new CloudUsageError("cloud account label must be 1-120 printable characters");
  }
  return label;
}

function safeAccountPlan(raw: string | undefined): CloudAccountRecord["plan"] | undefined {
  if (raw === undefined) return;
  if (raw !== "free" && raw !== "team" && raw !== "enterprise") {
    throw new CloudUsageError("cloud account plan must be free, team, or enterprise");
  }
  return raw;
}

function safeAccountStatus(raw: string | undefined): Exclude<CloudAccountRecord["status"], "deleted"> | undefined {
  if (raw === undefined) return;
  if (raw !== "active" && raw !== "suspended") {
    throw new CloudUsageError("cloud account status must be active or suspended");
  }
  return raw;
}

function safePositiveInteger(
  raw: string | undefined,
  flag: string,
  maximum: number,
  required = false,
): number | undefined {
  if (raw === undefined && !required) return;
  if (!raw || !/^[1-9]\d*$/.test(raw)) throw new CloudUsageError(`${flag} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new CloudUsageError(`${flag} must be between 1 and ${maximum}`);
  }
  return value;
}

function expectedRevision(options: CliOptions): number {
  return safePositiveInteger(options.expectedRevision, "--expected-revision", Number.MAX_SAFE_INTEGER, true)!;
}

function privateOutputPath(options: CliOptions): string {
  const path = options.output?.trim();
  if (!path || path.includes("\0")) {
    throw new CloudUsageError("cloud account credential output requires --output <path>");
  }
  return path;
}

function statOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function credentialFingerprint(credential: string): string {
  return createHash("sha256").update("roamcode-private-credential-file-v1\0").update(credential).digest("base64url");
}

function stageAccountCredential(outputPath: string, credential: string, allowReplace: boolean): StagedCredentialFile {
  const pendingPath = `${outputPath}.pending`;
  let createdPending = false;
  try {
    if (statOrUndefined(pendingPath)) {
      throw new CloudUsageError(
        "a private .pending credential already exists next to --output; recover or remove it before retrying",
      );
    }
    const existing = statOrUndefined(outputPath);
    if (existing && !allowReplace) {
      throw new CloudUsageError("--output already exists; choose a new path so no credential is overwritten");
    }
    let outputIdentity: StagedCredentialFile["outputIdentity"];
    let outputFingerprint: string | undefined;
    if (existing) {
      outputFingerprint = credentialFingerprint(readCloudAccountCredential(outputPath));
      const verified = lstatSync(outputPath);
      if (!verified.isFile() || verified.isSymbolicLink()) {
        throw new CloudUsageError("--output changed while its current credential was being verified");
      }
      outputIdentity = { dev: verified.dev, ino: verified.ino };
    }
    const descriptor = openSync(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    createdPending = true;
    let pendingIdentity: StagedCredentialFile["pendingIdentity"];
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${credential}\n`, "utf8");
      fsyncSync(descriptor);
      const staged = fstatSync(descriptor);
      pendingIdentity = { dev: staged.dev, ino: staged.ino };
    } finally {
      closeSync(descriptor);
    }
    fsyncParent(pendingPath);
    return {
      outputPath,
      pendingPath,
      replaceExisting: existing !== undefined,
      pendingIdentity,
      pendingFingerprint: credentialFingerprint(credential),
      ...(outputIdentity === undefined ? {} : { outputIdentity }),
      ...(outputFingerprint === undefined ? {} : { outputFingerprint }),
    };
  } catch (error) {
    if (error instanceof CloudUsageError) throw error;
    if (createdPending) {
      try {
        unlinkSync(pendingPath);
      } catch {
        /* Nothing durable was staged. */
      }
    }
    throw new CloudOperationError("cloud account credential could not be staged in a private file");
  }
}

function loadStagedCredential(outputPath: string): { staged: StagedCredentialFile; credential: string } {
  const pendingPath = `${outputPath}.pending`;
  if (!statOrUndefined(pendingPath)) {
    throw new CloudUsageError("no private .pending credential exists next to --output");
  }
  const credential = readCloudAccountCredential(pendingPath);
  const pending = lstatSync(pendingPath);
  const existing = statOrUndefined(outputPath);
  let outputIdentity: StagedCredentialFile["outputIdentity"];
  let outputFingerprint: string | undefined;
  if (existing) {
    outputFingerprint = credentialFingerprint(readCloudAccountCredential(outputPath));
    const verified = lstatSync(outputPath);
    if (!verified.isFile() || verified.isSymbolicLink()) {
      throw new CloudUsageError("--output changed while its current credential was being verified");
    }
    outputIdentity = { dev: verified.dev, ino: verified.ino };
  }
  return {
    credential,
    staged: {
      outputPath,
      pendingPath,
      replaceExisting: existing !== undefined,
      pendingIdentity: { dev: pending.dev, ino: pending.ino },
      pendingFingerprint: credentialFingerprint(credential),
      ...(outputIdentity === undefined ? {} : { outputIdentity }),
      ...(outputFingerprint === undefined ? {} : { outputFingerprint }),
    },
  };
}

function sameIdentity(path: string, identity: { dev: number; ino: number }): boolean {
  try {
    const current = lstatSync(path);
    return (
      current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino
    );
  } catch {
    return false;
  }
}

function sameCredentialFile(staged: StagedCredentialFile, path: string, pending: boolean): boolean {
  const identity = pending ? staged.pendingIdentity : staged.outputIdentity;
  const fingerprint = pending ? staged.pendingFingerprint : staged.outputFingerprint;
  if (!identity || !fingerprint || !sameIdentity(path, identity)) return false;
  try {
    return credentialFingerprint(readCloudAccountCredential(path)) === fingerprint;
  } catch {
    return false;
  }
}

function fsyncParent(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && !(process.platform === "win32" && code === "EPERM")) {
      throw error;
    }
    /* The file itself was fsynced; these platforms do not support fsync on directories. */
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function commitStagedCredential(staged: StagedCredentialFile): void {
  try {
    if (!sameCredentialFile(staged, staged.pendingPath, true)) {
      throw new Error("staged credential changed");
    }
    if (staged.replaceExisting) {
      if (!sameCredentialFile(staged, staged.outputPath, false)) {
        throw new Error("existing credential changed");
      }
      renameSync(staged.pendingPath, staged.outputPath);
    } else {
      linkSync(staged.pendingPath, staged.outputPath);
      unlinkSync(staged.pendingPath);
    }
  } catch {
    throw new CloudOperationError(
      "the cloud mutation succeeded, but its credential could not be committed; recover the private .pending file before retrying",
    );
  }
  try {
    fsyncParent(staged.outputPath);
  } catch {
    throw new CloudOperationError(
      "the cloud mutation succeeded and its credential was written, but directory durability could not be confirmed; verify the private output before retrying",
    );
  }
}

function removeStagedCredential(staged: StagedCredentialFile): void {
  if (!sameCredentialFile(staged, staged.pendingPath, true)) return;
  try {
    unlinkSync(staged.pendingPath);
    fsyncParent(staged.pendingPath);
  } catch {
    /* Best effort: never obscure the relay's authoritative mutation rejection. */
  }
}

function safeRemoteMessage(value: unknown, presentedCredential: string): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized &&
    normalized.length <= 160 &&
    !UNSAFE_TERMINAL_TEXT.test(normalized) &&
    !normalized.includes(presentedCredential) &&
    !/\b(?:rr[a-z]|rc[a-z])_[A-Za-z0-9_-]{20,}\b|\bsha256:[A-Za-z0-9_-]{43}\b|\bBearer\s+/i.test(normalized)
    ? normalized
    : undefined;
}

function isDefinitiveMutationRejection(error: unknown): error is CloudOperationError {
  return (
    error instanceof CloudOperationError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  );
}

async function responseText(response: Response, service = "cloud relay"): Promise<string> {
  if (!response.body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* The size violation is already authoritative. */
        }
        throw new CloudOperationError(`${service} returned an oversized response`, response.status);
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    if (error instanceof CloudOperationError) throw error;
    throw new CloudOperationError(`${service} response ended unexpectedly`, response.status);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  path: string,
  credential: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown },
  service = "cloud relay",
): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, `${origin}/`), {
      method: init.method,
      headers,
      redirect: "error",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CloudOperationError(`could not reach the ${service}`);
  }
  const announcedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      /* The bounded response rejection remains authoritative. */
    }
    throw new CloudOperationError(`${service} returned an oversized response`, response.status);
  }
  const text = await responseText(response, service);
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
      const code = safeRemoteMessage(parsed.code, credential);
      const message = safeRemoteMessage(parsed.error, credential);
      detail = [code, message].filter(Boolean).join(": ") || undefined;
    } catch {
      /* Never echo an arbitrary proxy/HTML body into a terminal transcript. */
    }
    throw new CloudOperationError(
      `${service} request failed (${response.status}${detail ? ` ${detail}` : ""})`,
      response.status,
    );
  }
  if (response.status === 204 || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudOperationError(`${service} returned an invalid response`, response.status);
  }
}

function parseRouteResponse(value: unknown, expectedRouteId: string): CloudRouteResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud relay returned an invalid route response");
  }
  const route = (value as { route?: unknown }).route;
  const id = route && typeof route === "object" && !Array.isArray(route) ? (route as { id?: unknown }).id : undefined;
  if (id !== expectedRouteId) throw new CloudOperationError("cloud relay returned a mismatched route response");
  return { route: { id: expectedRouteId } };
}

function parseStatusResponse(value: unknown, expectedRouteId: string): CloudRouteStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud relay returned an invalid status response");
  }
  const status = value as Record<string, unknown>;
  if (
    status.routeId !== expectedRouteId ||
    typeof status.hostOnline !== "boolean" ||
    !Number.isSafeInteger(status.activeDevices) ||
    (status.activeDevices as number) < 0
  ) {
    throw new CloudOperationError("cloud relay returned an invalid status response");
  }
  return {
    routeId: expectedRouteId,
    hostOnline: status.hostOnline,
    activeDevices: status.activeDevices as number,
  };
}

function parseAccountRecord(value: unknown): CloudAccountRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud relay returned an invalid account response");
  }
  const account = value as Record<string, unknown>;
  if (
    typeof account.id !== "string" ||
    !/^rra_[A-Za-z0-9_-]{16,128}$/.test(account.id) ||
    typeof account.label !== "string" ||
    !account.label ||
    account.label.length > 120 ||
    UNSAFE_TERMINAL_TEXT.test(account.label) ||
    (account.status !== "active" && account.status !== "suspended" && account.status !== "deleted") ||
    (account.plan !== "free" && account.plan !== "team" && account.plan !== "enterprise") ||
    !Number.isSafeInteger(account.maxRoutes) ||
    (account.maxRoutes as number) < 1 ||
    !Number.isSafeInteger(account.maxDevicesPerRoute) ||
    (account.maxDevicesPerRoute as number) < 1 ||
    !Number.isSafeInteger(account.revision) ||
    (account.revision as number) < 1
  ) {
    throw new CloudOperationError("cloud relay returned an invalid account response");
  }
  return account as unknown as CloudAccountRecord;
}

function parseAccountEnvelope(value: unknown, expectedAccountId?: string): CloudAccountRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud relay returned an invalid account response");
  }
  const account = parseAccountRecord((value as { account?: unknown }).account);
  if (expectedAccountId !== undefined && account.id !== expectedAccountId) {
    throw new CloudOperationError("cloud relay returned a mismatched account response");
  }
  return account;
}

function parseAccountInventory(value: unknown): CloudAccountRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudOperationError("cloud relay returned an invalid account inventory");
  }
  const accounts = (value as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) throw new CloudOperationError("cloud relay returned an invalid account inventory");
  return accounts.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CloudOperationError("cloud relay returned an invalid account inventory");
    }
    return parseAccountRecord((entry as { account?: unknown }).account);
  });
}

function accountSummary(account: CloudAccountRecord): string {
  return [
    `Account: ${account.id}`,
    `Label: ${account.label}`,
    `Status: ${account.status}`,
    `Plan: ${account.plan}`,
    `Routes: ${account.maxRoutes}`,
    `Devices per route: ${account.maxDevicesPerRoute}`,
    `Revision: ${account.revision}`,
  ].join("\n");
}

function pendingMutationError(action: "creation" | "rotation"): CloudOperationError {
  return new CloudOperationError(
    `cloud account ${action} could not be confirmed; a private .pending credential was retained next to --output for recovery`,
  );
}

async function runCloudAccountCommand(
  input: CloudCommandOptions,
  action: CloudAccountAction,
  fetchImpl: typeof globalThis.fetch,
): Promise<number> {
  if (action === "account-delete" && !input.options.confirm) {
    throw new CloudUsageError("cloud account-delete is permanent; rerun with --confirm to continue");
  }
  const origin = cloudOrigin(input.options.publicUrl ?? input.env.ROAMCODE_CLOUD_URL ?? DEFAULT_CLOUD_URL);

  if (action === "account-recover") {
    const { staged, credential } = loadStagedCredential(privateOutputPath(input.options));
    const account = parseAccountEnvelope(
      await requestJson(fetchImpl, origin, "/v1/account/recovery", credential, { method: "GET" }),
      input.options.accountId === undefined ? undefined : safeAccountId(input.options.accountId),
    );
    commitStagedCredential(staged);
    input.stdout(`Cloud account credential recovered and saved privately.\n${accountSummary(account)}\n`);
    return 0;
  }

  const root = rootCredential(input.options, input.env);

  if (action === "account-list") {
    const accounts = parseAccountInventory(
      await requestJson(fetchImpl, origin, "/v1/accounts", root, { method: "GET" }),
    );
    if (accounts.length === 0) {
      input.stdout("No cloud accounts.\n");
      return 0;
    }
    input.stdout(`${accounts.map(accountSummary).join("\n\n")}\n`);
    return 0;
  }

  if (action === "account-create") {
    const label = safeAccountLabel(input.options.label, true)!;
    const plan = safeAccountPlan(input.options.plan);
    const maxRoutes = safePositiveInteger(input.options.maxRoutes, "--max-routes", 10_000);
    const maxDevicesPerRoute = safePositiveInteger(
      input.options.maxDevicesPerRoute,
      "--max-devices-per-route",
      100_000,
    );
    const accountCredential = (input.generateAccountCredential ?? generateRelayAccountCredential)();
    if (!/^rrk_[A-Za-z0-9_-]{43}$/.test(accountCredential)) {
      throw new CloudOperationError("could not generate a valid cloud account credential");
    }
    const staged = stageAccountCredential(privateOutputPath(input.options), accountCredential, false);
    let response: unknown;
    try {
      response = await requestJson(fetchImpl, origin, "/v1/accounts/client-hashed", root, {
        method: "POST",
        body: {
          label,
          ...(plan === undefined ? {} : { plan }),
          ...(maxRoutes === undefined ? {} : { maxRoutes }),
          ...(maxDevicesPerRoute === undefined ? {} : { maxDevicesPerRoute }),
          credentialHash: relayAccountCredentialHash(accountCredential),
          credentialLookup: relayAccountCredentialLookup(accountCredential),
        },
      });
    } catch (error) {
      if (isDefinitiveMutationRejection(error)) removeStagedCredential(staged);
      else throw pendingMutationError("creation");
      throw error;
    }
    let account: CloudAccountRecord;
    try {
      account = parseAccountEnvelope(response);
    } catch {
      throw pendingMutationError("creation");
    }
    commitStagedCredential(staged);
    input.stdout(`Cloud account created. Credential saved privately.\n${accountSummary(account)}\n`);
    return 0;
  }

  const accountId = safeAccountId(input.options.accountId);
  const revision = expectedRevision(input.options);
  if (action === "account-rotate") {
    const accountCredential = (input.generateAccountCredential ?? generateRelayAccountCredential)();
    if (!/^rrk_[A-Za-z0-9_-]{43}$/.test(accountCredential)) {
      throw new CloudOperationError("could not generate a valid cloud account credential");
    }
    const staged = stageAccountCredential(privateOutputPath(input.options), accountCredential, true);
    let response: unknown;
    try {
      response = await requestJson(
        fetchImpl,
        origin,
        `/v1/accounts/${encodeURIComponent(accountId)}/credential/client-hashed`,
        root,
        {
          method: "POST",
          body: {
            expectedRevision: revision,
            credentialHash: relayAccountCredentialHash(accountCredential),
            credentialLookup: relayAccountCredentialLookup(accountCredential),
          },
        },
      );
    } catch (error) {
      if (isDefinitiveMutationRejection(error)) removeStagedCredential(staged);
      else throw pendingMutationError("rotation");
      throw error;
    }
    let account: CloudAccountRecord;
    try {
      account = parseAccountEnvelope(response, accountId);
    } catch {
      throw pendingMutationError("rotation");
    }
    commitStagedCredential(staged);
    input.stdout(`Cloud account credential rotated and saved privately.\n${accountSummary(account)}\n`);
    return 0;
  }

  const body: Record<string, unknown> = { expectedRevision: revision };
  if (action === "account-delete") {
    body.status = "deleted";
  } else {
    const label = safeAccountLabel(input.options.label, false);
    const plan = safeAccountPlan(input.options.plan);
    const status = safeAccountStatus(input.options.accountStatus);
    const maxRoutes = safePositiveInteger(input.options.maxRoutes, "--max-routes", 10_000);
    const maxDevicesPerRoute = safePositiveInteger(
      input.options.maxDevicesPerRoute,
      "--max-devices-per-route",
      100_000,
    );
    if (
      label === undefined &&
      plan === undefined &&
      status === undefined &&
      maxRoutes === undefined &&
      maxDevicesPerRoute === undefined
    ) {
      throw new CloudUsageError(
        "account-update requires --label, --plan, --account-status, --max-routes, or --max-devices-per-route",
      );
    }
    Object.assign(body, {
      ...(label === undefined ? {} : { label }),
      ...(plan === undefined ? {} : { plan }),
      ...(status === undefined ? {} : { status }),
      ...(maxRoutes === undefined ? {} : { maxRoutes }),
      ...(maxDevicesPerRoute === undefined ? {} : { maxDevicesPerRoute }),
    });
  }
  const account = parseAccountEnvelope(
    await requestJson(fetchImpl, origin, `/v1/accounts/${encodeURIComponent(accountId)}`, root, {
      method: "PATCH",
      body,
    }),
    accountId,
  );
  input.stdout(
    `${action === "account-delete" ? "Cloud account deleted." : "Cloud account updated."}\n${accountSummary(account)}\n`,
  );
  return 0;
}

function restartIfInstalled(
  dataDir: string,
  readInstalled: (dataDir: string) => ServiceRecord | undefined,
  restartInstalled: (record: ServiceRecord) => RestartResult,
): boolean {
  const record = readInstalled(dataDir);
  if (!record) return false;
  const result = restartInstalled(record);
  if (!result.ok) {
    throw new CloudOperationError(
      "cloud configuration was saved, but the installed RoamCode service could not be restarted",
    );
  }
  return true;
}

function sameRelayHostConfig(current: PersistedRelayHostConfig | undefined, expected: RelayHostConfigInput): boolean {
  return (
    current?.version === 1 &&
    current.relayUrl === expected.relayUrl &&
    current.routeId === expected.routeId &&
    current.hostCredential === expected.hostCredential &&
    current.hostLabel === expected.hostLabel &&
    current.appUrl === expected.appUrl
  );
}

/**
 * Atomic rename and directory fsync have one unavoidable error boundary: a filesystem can report a late fsync
 * failure after the new pathname is already visible. Re-read the authoritative file before treating that as an
 * uncommitted write, so callers never roll back the remote route while the new local credential is actually active.
 */
function writeConfigVerified(
  dataDir: string,
  config: RelayHostConfigInput,
  writeConfig: NonNullable<CloudCommandOptions["writeConfig"]>,
  readConfig: NonNullable<CloudCommandOptions["readConfig"]>,
): PersistedRelayHostConfig {
  try {
    return writeConfig(dataDir, config);
  } catch (error) {
    try {
      const current = readConfig(dataDir);
      if (sameRelayHostConfig(current, config)) return current!;
    } catch {
      /* Preserve the original persistence failure. */
    }
    throw error;
  }
}

function removeConfigVerified(
  dataDir: string,
  removeConfig: NonNullable<CloudCommandOptions["removeConfig"]>,
  readConfig: NonNullable<CloudCommandOptions["readConfig"]>,
): boolean {
  try {
    return removeConfig(dataDir);
  } catch (error) {
    try {
      if (readConfig(dataDir) === undefined) return true;
    } catch {
      /* Preserve the original persistence failure. */
    }
    throw error;
  }
}

function sameCloudHostConfig(current: CloudHostConfig | undefined, expected: CloudHostConfig): boolean {
  return current !== undefined && JSON.stringify(current) === JSON.stringify(expected);
}

function writeManagedCloudHostConfigVerified(
  path: string,
  config: CloudHostConfig,
  writeConfig: NonNullable<CloudCommandOptions["writeCloudHostConfig"]>,
  readConfig: NonNullable<CloudCommandOptions["readCloudHostConfig"]>,
): CloudHostConfig {
  try {
    return writeConfig(path, config);
  } catch (error) {
    try {
      const current = readConfig(path);
      if (sameCloudHostConfig(current, config)) return current!;
    } catch {
      /* Preserve the original persistence failure. */
    }
    throw error;
  }
}

function removeManagedCloudHostConfigVerified(
  path: string,
  removeConfig: NonNullable<CloudCommandOptions["removeCloudHostConfig"]>,
  readConfig: NonNullable<CloudCommandOptions["readCloudHostConfig"]>,
): boolean {
  try {
    return removeConfig(path);
  } catch (error) {
    try {
      if (readConfig(path) === undefined) return true;
    } catch {
      /* Preserve the original persistence failure. */
    }
    throw error;
  }
}

async function bestEffortDelete(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  routeId: string,
  credential: string,
): Promise<boolean> {
  try {
    await requestJson(fetchImpl, origin, `/v1/account/routes/${encodeURIComponent(routeId)}`, credential, {
      method: "DELETE",
    });
    return true;
  } catch (error) {
    return error instanceof CloudOperationError && error.status === 404;
  }
}

async function bestEffortRestoreHostCredential(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  routeId: string,
  accountCredential: string,
  previousHostCredential: string,
): Promise<boolean> {
  try {
    await requestJson(
      fetchImpl,
      origin,
      `/v1/account/routes/${encodeURIComponent(routeId)}/credential`,
      accountCredential,
      { method: "POST", body: { credentialHash: relayCredentialHash(previousHostCredential) } },
    );
    return true;
  } catch {
    return false;
  }
}

async function createCloudPairing(
  input: CloudCommandOptions,
  dataDir: string,
  fetchImpl: typeof globalThis.fetch,
  hostedApp: boolean,
): Promise<number> {
  const relay = resolveRelayHostConfig(input.env, dataDir);
  if (!relay) throw new CloudUsageError("cloud access is not configured; run `roamcode cloud connect` first");
  if (!relay.appUrl) {
    throw new CloudUsageError(
      "cloud pairing needs a trusted app URL; run `roamcode cloud configure --app-url <origin>` first",
    );
  }
  const origin = apiOriginForRelay(relay);
  const status = parseStatusResponse(
    await requestJson(
      fetchImpl,
      origin,
      `/v1/routes/${encodeURIComponent(relay.routeId)}/status`,
      relay.hostCredential,
      { method: "GET" },
    ),
    relay.routeId,
  );
  if (!status.hostOnline) {
    throw new CloudOperationError(
      "cloud host is offline; start or restart RoamCode before creating a remote pairing link",
    );
  }
  const provisioner = createRelayDeviceProvisioner({
    relayUrl: relay.relayUrl,
    routeId: relay.routeId,
    hostCredential: relay.hostCredential,
    request: fetchImpl,
  });
  const store = openDeviceStore({ dbPath: join(dataDir, "devices.db") });
  if (store.mode !== "sqlite") {
    store.close();
    throw new CloudOperationError("cloud pairing requires a working better-sqlite3 install");
  }
  let pendingDeviceId: string | undefined;
  try {
    const pairing = store.issueRelayPairing();
    pendingDeviceId = pairing.deviceId;
    const deviceCredential = (input.generateDeviceCredential ?? (() => generateRelayCredential("rrd")))();
    if (!/^rrd_[A-Za-z0-9_-]{43}$/.test(deviceCredential)) {
      throw new CloudOperationError("could not generate a valid cloud device credential");
    }
    await provisioner.putDevice(pairing.deviceId, relayCredentialHash(deviceCredential), pairing.expiresAt);
    const payload: RelayPairingPackage = {
      v: 1,
      label: relay.hostLabel,
      relayUrl: relay.relayUrl,
      routeId: relay.routeId,
      deviceId: pairing.deviceId,
      deviceCredential,
      deviceToken: pairing.token,
      pairingSecret: pairing.secret,
      expiresAt: pairing.expiresAt,
      hostIdentityPublicKey: relay.hostIdentity.publicKey,
      hostIdentityFingerprint: relay.hostIdentity.fingerprint,
    };
    const link = buildRelayPairingUrl(relay.appUrl, payload, { hostedApp });
    const qr = await renderTerminalQr(link);
    input.stdout(
      `Pair a device through RoamCode Cloud\n\n${qr}\nOpen this one-time link on the new device:\n${link}\n\n` +
        "Expires in 5 minutes and can be used once. Prompts, code, terminal output, and provider credentials remain end-to-end encrypted.\n",
    );
    return 0;
  } catch (error) {
    if (pendingDeviceId) {
      try {
        store.cancelRelayPairing(pendingDeviceId);
      } catch {
        /* The local bootstrap remains expiry-bounded. */
      }
      await provisioner.revokeDevice(pendingDeviceId).catch(() => {
        /* The broker-side bootstrap carries the same expiry. */
      });
    }
    if (error instanceof CloudOperationError) throw error;
    if (error instanceof Error && error.message.startsWith("could not provision relay device: ")) {
      throw new CloudOperationError(error.message);
    }
    throw new CloudOperationError("could not create a one-use cloud pairing link");
  } finally {
    store.close();
  }
}

function generateManagedCloudHostCredential(input: CloudCommandOptions): string {
  const credential = (input.generateCloudHostCredential ?? (() => `rch_${randomBytes(48).toString("base64url")}`))();
  if (!CLOUD_HOST_CREDENTIAL.test(credential)) {
    throw new CloudOperationError("could not generate a valid cloud host credential");
  }
  return credential;
}

function generateManagedRelayHostCredential(input: CloudCommandOptions): string {
  const credential = (input.generateHostCredential ?? (() => generateRelayCredential("rrh")))();
  if (!RELAY_HOST_CREDENTIAL.test(credential)) {
    throw new CloudOperationError("could not generate a valid relay host credential");
  }
  return credential;
}

function generateManagedUuid(generator: (() => string) | undefined, label: string): string {
  const value = (generator ?? randomUUID)();
  if (!UUID.test(value)) throw new CloudOperationError(`could not generate a valid ${label}`);
  return value;
}

async function runManagedCloudConnect(
  input: CloudCommandOptions,
  dataDir: string,
  fetchImpl: typeof globalThis.fetch,
  label: string,
  readRelayConfig: NonNullable<CloudCommandOptions["readConfig"]>,
  writeRelayConfig: NonNullable<CloudCommandOptions["writeConfig"]>,
  readManagedConfig: NonNullable<CloudCommandOptions["readCloudHostConfig"]>,
  writeManagedConfig: NonNullable<CloudCommandOptions["writeCloudHostConfig"]>,
  readInstalled: NonNullable<CloudCommandOptions["readInstalledService"]>,
  restartInstalled: NonNullable<CloudCommandOptions["restartInstalledService"]>,
): Promise<number> {
  const cloudConfigPath = cloudHostConfigPath(dataDir);
  const pending = readManagedOperation(dataDir);
  const resumedOperation = pending !== undefined;
  const currentRelay = readRelayConfig(dataDir);
  const currentCloud = readManagedConfig(cloudConfigPath);
  if (!pending && (currentRelay || currentCloud)) {
    throw new CloudUsageError(
      currentRelay && currentCloud
        ? "cloud access is already configured; disconnect it before provisioning another Node"
        : "cloud host configuration is incomplete; restore the pending operation or disconnect before retrying",
    );
  }
  if (pending && pending.action !== "connect") {
    throw new CloudUsageError("a cloud credential rotation is pending; rerun `roamcode cloud rotate`");
  }
  if (pending && pending.label !== label) {
    throw new CloudUsageError(
      `a cloud connection for ${JSON.stringify(pending.label)} is pending; rerun with the same --label`,
    );
  }

  const identityResult = await managedControlPlaneRequest(
    input,
    dataDir,
    fetchImpl,
    "/api/v1/auth/me",
    { method: "GET" },
    pending?.controlPlaneOrigin,
  );
  const identity = parseManagedIdentity(identityResult.value);
  if (pending && pending.organizationId !== identity.organizationId) {
    throw new CloudUsageError("the pending cloud host operation belongs to another Personal or Organization context");
  }
  let operation = pending;
  if (!operation) {
    const hostId = generateManagedUuid(input.generateHostId, "Node id");
    operation = writeManagedOperation(dataDir, {
      version: 1,
      kind: "managed-cloud-host-operation",
      action: "connect",
      controlPlaneOrigin: identityResult.origin,
      organizationId: identity.organizationId,
      hostId,
      operationId: generateManagedUuid(input.generateOperationId, "operation id"),
      label,
      slug: managedHostSlug(label, hostId),
      cloudHostCredential: generateManagedCloudHostCredential(input),
      relayHostCredential: generateManagedRelayHostCredential(input),
      createdAt: (input.now ?? Date.now)(),
    });
  }

  let result: { origin: string; value: unknown };
  try {
    result = await managedControlPlaneRequest(
      input,
      dataDir,
      fetchImpl,
      `/api/v1/orgs/${encodeURIComponent(operation.organizationId)}/hosts`,
      {
        method: "POST",
        body: {
          host_id: operation.hostId,
          operation_id: operation.operationId,
          name: operation.label,
          slug: operation.slug,
          host_credential: operation.cloudHostCredential,
          relay_credential_hash: relayCredentialHash(operation.relayHostCredential),
          relay_host_identity: (() => {
            const relayIdentity = loadOrCreateRelayIdentity({ dataDir }).identity;
            return { public_key: relayIdentity.publicKey, fingerprint: relayIdentity.fingerprint };
          })(),
        },
      },
      operation.controlPlaneOrigin,
    );
  } catch (error) {
    // A retry can follow an ambiguous response where the control plane already committed the
    // operation. A later 4xx (notably a rate limit) is not proof that the earlier request did not
    // mutate state, so never discard the only local copy of the generated credentials on resume.
    if (!resumedOperation && isDefinitiveMutationRejection(error)) {
      try {
        removeManagedOperation(dataDir);
      } catch {
        /* Preserve the control plane's authoritative rejection. */
      }
    }
    throw error;
  }
  const provisioned = parseManagedProvisioningResponse(result.value, operation);
  try {
    writeManagedCloudHostConfigVerified(cloudConfigPath, provisioned.hostConfig, writeManagedConfig, readManagedConfig);
    writeConfigVerified(
      dataDir,
      { ...provisioned.relayConfig, hostCredential: operation.relayHostCredential },
      writeRelayConfig,
      readRelayConfig,
    );
  } catch {
    throw new CloudOperationError(
      "the Node was provisioned, but its private local configuration was not fully committed; rerun `roamcode cloud connect` to recover",
    );
  }
  removeManagedOperation(dataDir);
  const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
  input.stdout(
    restarted
      ? "Cloud Node connected. The installed RoamCode service was restarted.\n"
      : "Cloud Node connected. Start RoamCode to bring it online.\n",
  );
  return 0;
}

async function runManagedCloudRotate(
  input: CloudCommandOptions,
  dataDir: string,
  fetchImpl: typeof globalThis.fetch,
  relayConfig: PersistedRelayHostConfig,
  cloudConfig: CloudHostConfig,
  readRelayConfig: NonNullable<CloudCommandOptions["readConfig"]>,
  writeRelayConfig: NonNullable<CloudCommandOptions["writeConfig"]>,
  readManagedConfig: NonNullable<CloudCommandOptions["readCloudHostConfig"]>,
  writeManagedConfig: NonNullable<CloudCommandOptions["writeCloudHostConfig"]>,
  readInstalled: NonNullable<CloudCommandOptions["readInstalledService"]>,
  restartInstalled: NonNullable<CloudCommandOptions["restartInstalledService"]>,
): Promise<number> {
  const pending = readManagedOperation(dataDir);
  const resumedOperation = pending !== undefined;
  if (pending && pending.action !== "rotate") {
    throw new CloudUsageError("a cloud connection is pending; rerun `roamcode cloud connect`");
  }
  if (pending && (pending.hostId !== cloudConfig.hostId || pending.organizationId !== cloudConfig.organizationId)) {
    throw new CloudUsageError("the pending cloud rotation does not belong to the configured Node");
  }
  const operation =
    pending ??
    writeManagedOperation(dataDir, {
      version: 1,
      kind: "managed-cloud-host-operation",
      action: "rotate",
      controlPlaneOrigin: cloudConfig.controlPlaneOrigin,
      organizationId: cloudConfig.organizationId,
      hostId: cloudConfig.hostId,
      operationId: generateManagedUuid(input.generateOperationId, "operation id"),
      label: relayConfig.hostLabel,
      slug: managedHostSlug(relayConfig.hostLabel, cloudConfig.hostId),
      cloudHostCredential: generateManagedCloudHostCredential(input),
      relayHostCredential: generateManagedRelayHostCredential(input),
      createdAt: (input.now ?? Date.now)(),
    });
  let result: { origin: string; value: unknown };
  try {
    result = await managedControlPlaneRequest(
      input,
      dataDir,
      fetchImpl,
      `/api/v1/hosts/${encodeURIComponent(operation.hostId)}/rotate`,
      {
        method: "POST",
        body: {
          operation_id: operation.operationId,
          host_credential: operation.cloudHostCredential,
          relay_credential_hash: relayCredentialHash(operation.relayHostCredential),
          relay_host_identity: (() => {
            const relayIdentity = loadOrCreateRelayIdentity({ dataDir }).identity;
            return { public_key: relayIdentity.publicKey, fingerprint: relayIdentity.fingerprint };
          })(),
        },
      },
      operation.controlPlaneOrigin,
    );
  } catch (error) {
    // Preserve a resumed operation on every HTTP failure: an earlier ambiguous attempt may have
    // committed both trust-boundary credentials before its response was lost.
    if (!resumedOperation && isDefinitiveMutationRejection(error)) {
      try {
        removeManagedOperation(dataDir);
      } catch {
        /* Preserve the control plane's authoritative rejection. */
      }
    }
    throw error;
  }
  const provisioned = parseManagedProvisioningResponse(result.value, operation);
  try {
    writeManagedCloudHostConfigVerified(
      cloudHostConfigPath(dataDir),
      provisioned.hostConfig,
      writeManagedConfig,
      readManagedConfig,
    );
    writeConfigVerified(
      dataDir,
      { ...provisioned.relayConfig, hostCredential: operation.relayHostCredential },
      writeRelayConfig,
      readRelayConfig,
    );
  } catch {
    throw new CloudOperationError(
      "cloud credential rotation succeeded, but its private local configuration was not fully committed; rerun `roamcode cloud rotate` to recover",
    );
  }
  removeManagedOperation(dataDir);
  const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
  input.stdout(
    restarted
      ? "Cloud Node credentials rotated. The installed RoamCode service was restarted.\n"
      : "Cloud Node credentials rotated. Restart RoamCode to reconnect.\n",
  );
  return 0;
}

async function runManagedCloudDisconnect(
  input: CloudCommandOptions,
  dataDir: string,
  fetchImpl: typeof globalThis.fetch,
  relayConfig: PersistedRelayHostConfig | undefined,
  cloudConfig: CloudHostConfig | undefined,
  readRelayConfig: NonNullable<CloudCommandOptions["readConfig"]>,
  removeRelayConfig: NonNullable<CloudCommandOptions["removeConfig"]>,
  readManagedConfig: NonNullable<CloudCommandOptions["readCloudHostConfig"]>,
  removeManagedConfig: NonNullable<CloudCommandOptions["removeCloudHostConfig"]>,
  readInstalled: NonNullable<CloudCommandOptions["readInstalledService"]>,
  restartInstalled: NonNullable<CloudCommandOptions["restartInstalledService"]>,
): Promise<number> {
  if (!input.options.confirm) {
    throw new CloudUsageError("cloud disconnect deletes this Node route; rerun with --confirm to continue");
  }
  const pending = readManagedOperation(dataDir);
  const hostId = cloudConfig?.hostId ?? pending?.hostId;
  const origin = cloudConfig?.controlPlaneOrigin ?? pending?.controlPlaneOrigin;
  if (!hostId || !origin) throw new CloudUsageError("managed cloud access is not configured");
  try {
    await managedControlPlaneRequest(
      input,
      dataDir,
      fetchImpl,
      `/api/v1/hosts/${encodeURIComponent(hostId)}/revoke`,
      { method: "POST" },
      origin,
    );
  } catch (error) {
    if (!(error instanceof CloudOperationError && error.status === 404)) throw error;
  }
  try {
    if (relayConfig) removeConfigVerified(dataDir, removeRelayConfig, readRelayConfig);
    if (cloudConfig) {
      removeManagedCloudHostConfigVerified(cloudHostConfigPath(dataDir), removeManagedConfig, readManagedConfig);
    }
    if (pending) removeManagedOperation(dataDir);
  } catch {
    throw new CloudOperationError(
      "the managed Node was revoked, but its private local configuration could not be removed completely",
    );
  }
  const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
  input.stdout(
    restarted
      ? "Cloud Node disconnected. The installed RoamCode service was restarted.\n"
      : "Cloud Node disconnected.\n",
  );
  return 0;
}

export async function runCloudCommand(input: CloudCommandOptions): Promise<number> {
  const readConfig = input.readConfig ?? readRelayHostConfig;
  const writeConfig = input.writeConfig ?? writeRelayHostConfig;
  const removeConfig = input.removeConfig ?? removeRelayHostConfig;
  const readManagedConfig = input.readCloudHostConfig ?? readCloudHostConfig;
  const writeManagedConfig = input.writeCloudHostConfig ?? writeCloudHostConfig;
  const removeManagedConfig = input.removeCloudHostConfig ?? removeCloudHostConfig;
  const readInstalled = input.readInstalledService ?? readServiceRecord;
  const restartInstalled = input.restartInstalledService ?? restartService;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const dataDir = input.dataDir ?? resolveDataDir(input.env);

  try {
    const action = input.options.cloudAction;
    if (!action || !CLOUD_ACTIONS.includes(action as CloudAction)) {
      throw new CloudUsageError(`cloud action must be one of: ${CLOUD_ACTIONS.join(", ")}`);
    }
    if (action === "login" || action === "logout" || action === "whoami") {
      const { runCloudAuthCommand } = await import("./cloud-auth.js");
      return await runCloudAuthCommand({
        options: input.options,
        env: input.env,
        dataDir,
        stdout: input.stdout,
        stderr: input.stderr,
        fetch: fetchImpl,
        ...(input.authCredentialStore ? { credentialStore: input.authCredentialStore } : {}),
        ...(input.openBrowser ? { openBrowser: input.openBrowser } : {}),
        ...(input.sleep ? { sleep: input.sleep } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.processRunner ? { processRunner: input.processRunner } : {}),
        ...(input.detachedProcessRunner ? { detachedProcessRunner: input.detachedProcessRunner } : {}),
        ...(input.uid === undefined ? {} : { uid: input.uid }),
        ...(input.pid === undefined ? {} : { pid: input.pid }),
        ...(input.randomId ? { randomId: input.randomId } : {}),
      });
    }
    if (action.startsWith("account-")) {
      return await runCloudAccountCommand(input, action as CloudAccountAction, fetchImpl);
    }
    if (action === "pair") {
      const hostedApp = readManagedConfig(cloudHostConfigPath(dataDir)) !== undefined;
      return await createCloudPairing(input, dataDir, fetchImpl, hostedApp);
    }
    assertNoEnvironmentOverride(input.env);

    if (action === "configure") {
      const config = readConfig(dataDir);
      if (!config) throw new CloudUsageError("cloud access is not configured; run `roamcode cloud connect` first");
      if (!input.options.appUrl) {
        throw new CloudUsageError("cloud configure requires --app-url <trusted PWA origin>");
      }
      const appUrl = cloudAppOrigin(input.options.appUrl);
      try {
        writeConfigVerified(dataDir, { ...config, appUrl }, writeConfig, readConfig);
      } catch {
        throw new CloudOperationError("trusted cloud app URL could not be saved");
      }
      const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
      input.stdout(
        restarted
          ? "Trusted cloud app URL saved. The installed RoamCode service was restarted.\n"
          : "Trusted cloud app URL saved. Restart RoamCode to apply it.\n",
      );
      return 0;
    }

    if (action === "connect") {
      const label = safeLabel(input.options.label ?? input.env.ROAMCODE_CLOUD_HOST_LABEL);
      const explicitLegacyCredential = input.options.accountTokenFile ?? input.env.ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE;
      const pendingManagedOperation = readManagedOperation(dataDir);
      const currentManagedConfig = readManagedConfig(cloudHostConfigPath(dataDir));
      if (!explicitLegacyCredential || pendingManagedOperation || currentManagedConfig) {
        return await runManagedCloudConnect(
          input,
          dataDir,
          fetchImpl,
          label,
          readConfig,
          writeConfig,
          readManagedConfig,
          writeManagedConfig,
          readInstalled,
          restartInstalled,
        );
      }
      if (readConfig(dataDir)) {
        throw new CloudUsageError(
          "cloud access is already configured; disconnect it before provisioning another route",
        );
      }
      const credential = accountCredential(input.options, input.env);
      const origin = cloudOrigin(input.options.publicUrl ?? input.env.ROAMCODE_CLOUD_URL ?? DEFAULT_CLOUD_URL);
      const appUrl = cloudAppOrigin(input.options.appUrl ?? input.env.ROAMCODE_CLOUD_APP_URL ?? DEFAULT_CLOUD_APP_URL);
      const routeId = (input.generateRouteId ?? (() => `rrt_${randomBytes(18).toString("base64url")}`))();
      if (!/^rrt_[A-Za-z0-9_-]{16,128}$/.test(routeId)) {
        throw new CloudOperationError("could not generate a valid cloud route identity");
      }
      const hostCredential = (input.generateHostCredential ?? (() => generateRelayCredential("rrh")))();
      let provisioned = false;
      const recoverAmbiguousProvisioning = async (originalError: unknown): Promise<never> => {
        const cleaned = await bestEffortDelete(fetchImpl, origin, routeId, credential);
        if (cleaned) throw originalError;
        try {
          writeConfigVerified(
            dataDir,
            { relayUrl: origin, routeId, hostCredential, appUrl, hostLabel: label },
            writeConfig,
            readConfig,
          );
        } catch {
          throw new CloudOperationError(
            "cloud route provisioning, cleanup, and private recovery-state persistence could not be confirmed",
          );
        }
        throw new CloudOperationError(
          "cloud route provisioning and cleanup could not be confirmed; a private recovery configuration was saved. Run `roamcode cloud status`; if the route exists, restart RoamCode, otherwise run `roamcode cloud disconnect --confirm --account-token-file PATH` before retrying",
        );
      };
      try {
        const response = await requestJson(fetchImpl, origin, "/v1/account/routes", credential, {
          method: "POST",
          body: { id: routeId, label, credentialHash: relayCredentialHash(hostCredential) },
        });
        parseRouteResponse(response, routeId);
        provisioned = true;
      } catch (error) {
        if (isDefinitiveMutationRejection(error)) throw error;
        await recoverAmbiguousProvisioning(error);
      }
      try {
        writeConfigVerified(
          dataDir,
          { relayUrl: origin, routeId, hostCredential, appUrl, hostLabel: label },
          writeConfig,
          readConfig,
        );
      } catch {
        const cleaned = provisioned && (await bestEffortDelete(fetchImpl, origin, routeId, credential));
        throw new CloudOperationError(
          cleaned
            ? "cloud route was rolled back because its local configuration could not be saved"
            : "local cloud configuration could not be saved and the remote route could not be cleaned up",
        );
      }
      const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
      input.stdout(
        restarted
          ? "Cloud access connected. The installed RoamCode service was restarted.\n"
          : "Cloud access configured. Start RoamCode to bring this host online.\n",
      );
      return 0;
    }

    const config = readConfig(dataDir);
    const managedConfig = readManagedConfig(cloudHostConfigPath(dataDir));
    const pendingManagedOperation = readManagedOperation(dataDir);
    if (action === "disconnect" && (managedConfig || pendingManagedOperation)) {
      return await runManagedCloudDisconnect(
        input,
        dataDir,
        fetchImpl,
        config,
        managedConfig,
        readConfig,
        removeConfig,
        readManagedConfig,
        removeManagedConfig,
        readInstalled,
        restartInstalled,
      );
    }
    if (action === "rotate" && managedConfig) {
      if (!config) {
        throw new CloudUsageError(
          "managed cloud relay configuration is missing; rerun `roamcode cloud connect` to recover",
        );
      }
      return await runManagedCloudRotate(
        input,
        dataDir,
        fetchImpl,
        config,
        managedConfig,
        readConfig,
        writeConfig,
        readManagedConfig,
        writeManagedConfig,
        readInstalled,
        restartInstalled,
      );
    }
    if (!config) {
      if (action === "status") {
        input.stdout("Cloud access is not configured.\n");
        return 1;
      }
      throw new CloudUsageError("cloud access is not configured; run `roamcode cloud connect` first");
    }
    const origin = apiOriginForRelay(config);

    if (action === "status") {
      const response = await requestJson(
        fetchImpl,
        origin,
        `/v1/routes/${encodeURIComponent(config.routeId)}/status`,
        config.hostCredential,
        { method: "GET" },
      );
      const status = parseStatusResponse(response, config.routeId);
      input.stdout(
        [
          "Cloud access: configured",
          `Host relay: ${status.hostOnline ? "online" : "offline"}`,
          `Active devices: ${status.activeDevices}`,
        ].join("\n") + "\n",
      );
      return 0;
    }

    if (action === "disconnect" && !input.options.confirm) {
      throw new CloudUsageError("cloud disconnect deletes this host route; rerun with --confirm to continue");
    }
    const credential = accountCredential(input.options, input.env);
    if (action === "rotate") {
      const nextHostCredential = (input.generateHostCredential ?? (() => generateRelayCredential("rrh")))();
      const nextConfig: RelayHostConfigInput = { ...config, hostCredential: nextHostCredential };
      writeConfigVerified(dataDir, nextConfig, writeConfig, readConfig);
      try {
        await requestJson(
          fetchImpl,
          origin,
          `/v1/account/routes/${encodeURIComponent(config.routeId)}/credential`,
          credential,
          { method: "POST", body: { credentialHash: relayCredentialHash(nextHostCredential) } },
        );
      } catch (error) {
        const remoteRestored = isDefinitiveMutationRejection(error)
          ? true
          : await bestEffortRestoreHostCredential(fetchImpl, origin, config.routeId, credential, config.hostCredential);
        if (!remoteRestored) {
          throw new CloudOperationError(
            "cloud host credential rotation and its remote rollback could not be confirmed; the new credential remains saved locally, so rerun `roamcode cloud rotate` before restarting the host",
          );
        }
        try {
          writeConfigVerified(dataDir, config, writeConfig, readConfig);
        } catch {
          throw new CloudOperationError(
            "cloud credential rotation failed and the previous local configuration could not be restored",
          );
        }
        throw error;
      }
      const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
      input.stdout(
        restarted
          ? "Cloud host credential rotated. The installed RoamCode service was restarted.\n"
          : "Cloud host credential rotated. Restart RoamCode to reconnect.\n",
      );
      return 0;
    }

    try {
      await requestJson(fetchImpl, origin, `/v1/account/routes/${encodeURIComponent(config.routeId)}`, credential, {
        method: "DELETE",
      });
    } catch (error) {
      if (!(error instanceof CloudOperationError && error.status === 404)) throw error;
    }
    try {
      removeConfigVerified(dataDir, removeConfig, readConfig);
    } catch {
      throw new CloudOperationError(
        "the remote route was deleted, but the local cloud configuration could not be removed",
      );
    }
    const restarted = restartIfInstalled(dataDir, readInstalled, restartInstalled);
    input.stdout(
      restarted
        ? "Cloud access disconnected. The installed RoamCode service was restarted.\n"
        : "Cloud access disconnected.\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "cloud command failed";
    input.stderr(`${message}\n`);
    return error instanceof CloudUsageError ? 2 : 1;
  }
}
