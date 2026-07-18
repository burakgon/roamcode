import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CliOptions } from "./args.js";

export const DEFAULT_CONTROL_PLANE_URL = "https://roamcode.ai";

export const CLOUD_AUTH_PATHS = {
  authorize: "/api/v1/auth/device/authorize",
  token: "/api/v1/auth/device/token",
  revoke: "/api/v1/auth/device/revoke",
  me: "/api/v1/auth/me",
} as const;

const CLOUD_AUTH_CLIENT_ID = "roamcode-cli";
const CLOUD_AUTH_SCOPE = "identity profile email offline_access organizations hosts hosts:write";
const CLOUD_AUTH_FILE = "cloud-session.json";
const CLOUD_AUTH_OPERATION_LOCK = "cloud-auth-operation.lock";
const KEYCHAIN_SERVICE = "ai.roamcode.cli.cloud";
const KEYCHAIN_ACCOUNT = "roamcode-cli";
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_CREDENTIAL_BYTES = 32 * 1_024;
const MAX_OPERATION_LOCK_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000;
const OPERATION_LOCK_STALE_MS = 30 * 60_000;
const MAX_TRANSIENT_POLL_FAILURES = 3;
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const OPAQUE_TOKEN = /^[\x21-\x7e]{20,4096}$/;

class CloudAuthUsageError extends Error {}
class CloudAuthOperationError extends Error {}
class CloudSessionExpiredError extends CloudAuthOperationError {}

export interface StoredCloudSession {
  version: 1;
  controlPlaneOrigin: string;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
  issuedAt: number;
  scope?: string;
}

/**
 * Device and refresh grants deliberately share one strict response contract. A refresh response MUST
 * contain a replacement refresh token; callers never keep using a token after presenting it.
 */
export interface RotatingCloudTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface CloudCredentialStore {
  read(): Promise<StoredCloudSession | undefined>;
  write(session: StoredCloudSession): Promise<void>;
  remove(): Promise<boolean>;
}

export interface ProcessInvocation {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
  overflow?: boolean;
}

export type ProcessRunner = (invocation: ProcessInvocation) => Promise<ProcessResult>;
export type DetachedProcessRunner = (command: string, args: string[]) => Promise<void>;
export type BrowserOpener = (url: string) => Promise<boolean>;

export interface CloudAuthCommandOptions {
  options: CliOptions;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  fetch: typeof globalThis.fetch;
  credentialStore?: CloudCredentialStore;
  openBrowser?: BrowserOpener;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  platform?: NodeJS.Platform;
  processRunner?: ProcessRunner;
  detachedProcessRunner?: DetachedProcessRunner;
  uid?: number;
  pid?: number;
  randomId?: () => string;
  /** Test seam; production uses a per-data-dir lock, or one per-user temporary lock for the global macOS Keychain. */
  operationLockDirectory?: string;
}

export interface CloudAccessSession {
  controlPlaneOrigin: string;
  accessToken: string;
}

interface DeviceAuthorizationResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

interface CloudIdentity {
  user: { email: string; name?: string };
  organization?: { name: string };
}

interface CloudAuthOperationLockOwner {
  pid: number;
  createdAt: number;
  nonce: string;
}

function controlledError(error: unknown): string {
  if (
    error instanceof CloudAuthUsageError ||
    error instanceof CloudAuthOperationError ||
    error instanceof CloudSessionExpiredError
  ) {
    return redactCloudAuthSecrets(error.message);
  }
  return "cloud authentication failed";
}

/** Defense in depth for future error paths: known OAuth fields and RoamCode-style secrets are never rendered. */
export function redactCloudAuthSecrets(message: string, secrets: readonly string[] = []): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted
    .replace(/\b(?:access|refresh|device)[_-]?token\s*[:=]\s*[^\s,;]+/giu, "token=[redacted]")
    .replace(/\b(?:rca|rcr|rcd)_[A-Za-z0-9_-]{20,}\b/gu, "[redacted]");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function normalizeControlPlaneOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CloudAuthUsageError("control-plane URL must be a valid HTTPS origin");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new CloudAuthUsageError(
      "control-plane URL must be an HTTPS origin without credentials, a path, query, or fragment",
    );
  }
  return url.origin;
}

function configuredControlPlaneOrigin(input: CloudAuthCommandOptions): string {
  return normalizeControlPlaneOrigin(
    input.options.controlPlaneUrl ?? input.env.ROAMCODE_CLOUD_CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL,
  );
}

function safeString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    UNSAFE_TEXT.test(value)
  ) {
    throw new CloudAuthOperationError(`control plane returned an invalid ${label}`);
  }
  return value;
}

function safeOpaqueToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_TOKEN.test(value)) {
    throw new CloudAuthOperationError(`control plane returned an invalid ${label}`);
  }
  return value;
}

function safePositiveInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CloudAuthOperationError(`control plane returned an invalid ${label}`);
  }
  return value as number;
}

function safeVerificationUrl(value: unknown, origin: string, label: string, allowQuery: boolean): string {
  const raw = safeString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudAuthOperationError(`control plane returned an invalid ${label}`);
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    (!allowQuery && url.search) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new CloudAuthOperationError(`control plane returned an untrusted ${label}`);
  }
  return url.toString();
}

function parseDeviceAuthorization(value: unknown, origin: string): DeviceAuthorizationResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudAuthOperationError("control plane returned an invalid device authorization response");
  }
  const response = value as Record<string, unknown>;
  const deviceCode = safeOpaqueToken(response.device_code, "device code");
  const userCode = safeString(response.user_code, "user code", 32);
  if (!/^[A-Za-z0-9-]{4,32}$/.test(userCode)) {
    throw new CloudAuthOperationError("control plane returned an invalid user code");
  }
  const parsed = {
    deviceCode,
    userCode,
    verificationUri: safeVerificationUrl(response.verification_uri, origin, "verification URL", false),
    ...(response.verification_uri_complete === undefined
      ? {}
      : {
          verificationUriComplete: safeVerificationUrl(
            response.verification_uri_complete,
            origin,
            "complete verification URL",
            true,
          ),
        }),
    expiresIn: safePositiveInteger(response.expires_in, "authorization expiry", 30, 900),
    interval: response.interval === undefined ? 5 : safePositiveInteger(response.interval, "polling interval", 1, 30),
  } satisfies DeviceAuthorizationResponse;
  if (
    parsed.verificationUriComplete &&
    (parsed.verificationUriComplete.includes(deviceCode) ||
      parsed.verificationUriComplete.includes(encodeURIComponent(deviceCode)))
  ) {
    throw new CloudAuthOperationError("control plane exposed the device credential in its verification URL");
  }
  return parsed;
}

function parseRotatingTokenResponse(value: unknown): RotatingCloudTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudAuthOperationError("control plane returned an invalid token response");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer") {
    throw new CloudAuthOperationError("control plane returned an unsupported token type");
  }
  const scope =
    response.scope === undefined ? undefined : safeString(response.scope, "token scope", 1_024, true).trim();
  return {
    access_token: safeOpaqueToken(response.access_token, "access token"),
    refresh_token: safeOpaqueToken(response.refresh_token, "refresh token"),
    token_type: "Bearer",
    expires_in: safePositiveInteger(response.expires_in, "access token expiry", 30, 86_400),
    ...(response.refresh_token_expires_in === undefined
      ? {}
      : {
          refresh_token_expires_in: safePositiveInteger(
            response.refresh_token_expires_in,
            "refresh token expiry",
            60,
            31_536_000,
          ),
        }),
    ...(scope ? { scope } : {}),
  };
}

function sessionFromTokenResponse(
  response: RotatingCloudTokenResponse,
  controlPlaneOrigin: string,
  now: number,
): StoredCloudSession {
  return {
    version: 1,
    controlPlaneOrigin,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: "Bearer",
    accessTokenExpiresAt: now + response.expires_in * 1_000,
    ...(response.refresh_token_expires_in === undefined
      ? {}
      : { refreshTokenExpiresAt: now + response.refresh_token_expires_in * 1_000 }),
    issuedAt: now,
    ...(response.scope ? { scope: response.scope } : {}),
  };
}

function parseStoredSession(value: unknown): StoredCloudSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudAuthOperationError("saved cloud session is invalid; run `roamcode cloud logout` and sign in again");
  }
  const session = value as Record<string, unknown>;
  let origin: string;
  try {
    origin = normalizeControlPlaneOrigin(
      typeof session.controlPlaneOrigin === "string" ? session.controlPlaneOrigin : "",
    );
  } catch {
    throw new CloudAuthOperationError("saved cloud session is invalid; run `roamcode cloud logout` and sign in again");
  }
  if (
    session.version !== 1 ||
    session.tokenType !== "Bearer" ||
    !Number.isSafeInteger(session.accessTokenExpiresAt) ||
    (session.accessTokenExpiresAt as number) < 1 ||
    !Number.isSafeInteger(session.issuedAt) ||
    (session.issuedAt as number) < 1 ||
    (session.refreshTokenExpiresAt !== undefined &&
      (!Number.isSafeInteger(session.refreshTokenExpiresAt) || (session.refreshTokenExpiresAt as number) < 1)) ||
    (session.scope !== undefined &&
      (typeof session.scope !== "string" || session.scope.length > 1_024 || UNSAFE_TEXT.test(session.scope)))
  ) {
    throw new CloudAuthOperationError("saved cloud session is invalid; run `roamcode cloud logout` and sign in again");
  }
  try {
    return {
      version: 1,
      controlPlaneOrigin: origin,
      accessToken: safeOpaqueToken(session.accessToken, "saved access token"),
      refreshToken: safeOpaqueToken(session.refreshToken, "saved refresh token"),
      tokenType: "Bearer",
      accessTokenExpiresAt: session.accessTokenExpiresAt as number,
      ...(session.refreshTokenExpiresAt === undefined
        ? {}
        : { refreshTokenExpiresAt: session.refreshTokenExpiresAt as number }),
      issuedAt: session.issuedAt as number,
      ...(typeof session.scope === "string" && session.scope ? { scope: session.scope } : {}),
    };
  } catch {
    throw new CloudAuthOperationError("saved cloud session is invalid; run `roamcode cloud logout` and sign in again");
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudAuthOperationError("control plane returned an oversized response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CloudAuthOperationError("control plane returned an oversized response");
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    if (error instanceof CloudAuthOperationError) throw error;
    throw new CloudAuthOperationError("control-plane response ended unexpectedly");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await boundedResponseText(response);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudAuthOperationError("control plane returned an invalid response");
  }
}

async function authFetch(
  input: CloudAuthCommandOptions,
  origin: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await input.fetch(new URL(path, `${origin}/`), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers).entries()) },
    });
  } catch {
    throw new CloudAuthOperationError("could not reach the RoamCode control plane");
  }
}

function formBody(fields: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

async function postForm(
  input: CloudAuthCommandOptions,
  origin: string,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return authFetch(input, origin, path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(fields),
  });
}

function oauthErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const code = (value as { error?: unknown }).error;
  return typeof code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : undefined;
}

async function startDeviceAuthorization(
  input: CloudAuthCommandOptions,
  origin: string,
): Promise<DeviceAuthorizationResponse> {
  const response = await postForm(input, origin, CLOUD_AUTH_PATHS.authorize, {
    client_id: CLOUD_AUTH_CLIENT_ID,
    scope: CLOUD_AUTH_SCOPE,
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const code = oauthErrorCode(body);
    throw new CloudAuthOperationError(
      `cloud sign-in could not be started (${response.status}${code ? ` ${code}` : ""})`,
    );
  }
  return parseDeviceAuthorization(body, origin);
}

async function pollForDeviceToken(
  input: CloudAuthCommandOptions,
  origin: string,
  authorization: DeviceAuthorizationResponse,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<RotatingCloudTokenResponse> {
  const deadline = now() + authorization.expiresIn * 1_000;
  let intervalMs = authorization.interval * 1_000;
  let transientFailures = 0;
  while (now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    let response: Response;
    try {
      response = await postForm(input, origin, CLOUD_AUTH_PATHS.token, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: authorization.deviceCode,
        client_id: CLOUD_AUTH_CLIENT_ID,
      });
    } catch (error) {
      transientFailures += 1;
      if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) throw error;
      continue;
    }
    let body: unknown;
    try {
      body = await responseJson(response);
    } catch (error) {
      if (response.status >= 500 && transientFailures + 1 < MAX_TRANSIENT_POLL_FAILURES) {
        transientFailures += 1;
        continue;
      }
      throw error;
    }
    if (response.ok) return parseRotatingTokenResponse(body);
    const code = oauthErrorCode(body);
    if (code === "authorization_pending") {
      transientFailures = 0;
      continue;
    }
    if (code === "slow_down" || response.status === 429) {
      intervalMs = Math.min(30_000, intervalMs + 5_000);
      transientFailures = 0;
      continue;
    }
    if (code === "access_denied") throw new CloudAuthOperationError("cloud sign-in was denied");
    if (code === "expired_token") throw new CloudAuthOperationError("cloud sign-in expired before approval");
    if (response.status >= 500 && transientFailures + 1 < MAX_TRANSIENT_POLL_FAILURES) {
      transientFailures += 1;
      continue;
    }
    throw new CloudAuthOperationError(`cloud sign-in failed (${response.status}${code ? ` ${code}` : ""})`);
  }
  throw new CloudAuthOperationError("cloud sign-in expired before approval; run `roamcode cloud login` again");
}

async function refreshSession(
  input: CloudAuthCommandOptions,
  store: CloudCredentialStore,
  session: StoredCloudSession,
  now: () => number,
): Promise<StoredCloudSession> {
  if (session.refreshTokenExpiresAt !== undefined && session.refreshTokenExpiresAt <= now()) {
    throw new CloudSessionExpiredError("cloud session expired; run `roamcode cloud login` again");
  }
  const response = await postForm(input, session.controlPlaneOrigin, CLOUD_AUTH_PATHS.token, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: CLOUD_AUTH_CLIENT_ID,
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const code = oauthErrorCode(body);
    if (code === "invalid_grant" || code === "invalid_token" || response.status === 401) {
      throw new CloudSessionExpiredError("cloud session expired; run `roamcode cloud login` again");
    }
    throw new CloudAuthOperationError(
      `cloud session could not be refreshed (${response.status}${code ? ` ${code}` : ""})`,
    );
  }
  const tokens = parseRotatingTokenResponse(body);
  if (tokens.refresh_token === session.refreshToken) {
    throw new CloudAuthOperationError("control plane did not rotate the refresh token; sign in again");
  }
  const next = sessionFromTokenResponse(tokens, session.controlPlaneOrigin, now());
  try {
    await store.write(next);
  } catch {
    throw new CloudAuthOperationError(
      "cloud session was refreshed but its replacement credentials could not be stored; sign in again",
    );
  }
  return next;
}

async function fetchIdentity(
  input: CloudAuthCommandOptions,
  session: StoredCloudSession,
): Promise<{ response: Response; body: unknown }> {
  const response = await authFetch(input, session.controlPlaneOrigin, CLOUD_AUTH_PATHS.me, {
    method: "GET",
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  return { response, body: await responseJson(response) };
}

function parseIdentity(value: unknown): CloudIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudAuthOperationError("control plane returned an invalid identity response");
  }
  const envelope = value as { user?: unknown; organization?: unknown };
  if (!envelope.user || typeof envelope.user !== "object" || Array.isArray(envelope.user)) {
    throw new CloudAuthOperationError("control plane returned an invalid identity response");
  }
  const user = envelope.user as Record<string, unknown>;
  const email = safeString(user.email, "account email", 320).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new CloudAuthOperationError("control plane returned an invalid account email");
  }
  const name =
    user.name === undefined || user.name === null ? undefined : safeString(user.name, "account name", 120).trim();
  let organization: CloudIdentity["organization"];
  if (envelope.organization !== undefined && envelope.organization !== null) {
    if (typeof envelope.organization !== "object" || Array.isArray(envelope.organization)) {
      throw new CloudAuthOperationError("control plane returned an invalid organization response");
    }
    organization = {
      name: safeString((envelope.organization as Record<string, unknown>).name, "organization name", 120).trim(),
    };
  }
  return { user: { email, ...(name ? { name } : {}) }, ...(organization ? { organization } : {}) };
}

async function revokeSession(input: CloudAuthCommandOptions, session: StoredCloudSession): Promise<void> {
  const response = await postForm(input, session.controlPlaneOrigin, CLOUD_AUTH_PATHS.revoke, {
    token: session.refreshToken,
    token_type_hint: "refresh_token",
    client_id: CLOUD_AUTH_CLIENT_ID,
  });
  const body = await responseJson(response);
  if (response.ok || response.status === 401 || oauthErrorCode(body) === "invalid_token") return;
  const code = oauthErrorCode(body);
  throw new CloudAuthOperationError(`cloud session could not be revoked (${response.status}${code ? ` ${code}` : ""})`);
}

async function runLogin(
  input: CloudAuthCommandOptions,
  store: CloudCredentialStore,
  openBrowser: BrowserOpener,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number> {
  if (await store.read()) {
    throw new CloudAuthUsageError("already signed in; run `roamcode cloud logout` before switching accounts");
  }
  const origin = configuredControlPlaneOrigin(input);
  const authorization = await startDeviceAuthorization(input, origin);
  input.stdout(
    `Sign in to RoamCode Cloud\n\nOpen ${authorization.verificationUri} and enter code:\n  ${authorization.userCode}\n`,
  );
  const opened = await openBrowser(authorization.verificationUriComplete ?? authorization.verificationUri);
  input.stdout(
    opened
      ? "\nA browser was opened. Waiting for approval…\n"
      : "\nA browser could not be opened. Continue at the URL above. Waiting for approval…\n",
  );
  const tokenResponse = await pollForDeviceToken(input, origin, authorization, now, sleep);
  const session = sessionFromTokenResponse(tokenResponse, origin, now());
  try {
    await store.write(session);
  } catch {
    await revokeSession(input, session).catch(() => undefined);
    throw new CloudAuthOperationError("cloud sign-in was approved, but credentials could not be stored securely");
  }
  input.stdout("Signed in to RoamCode Cloud.\n");
  return 0;
}

async function runLogout(input: CloudAuthCommandOptions, store: CloudCredentialStore): Promise<number> {
  let session: StoredCloudSession | undefined;
  try {
    session = await store.read();
  } catch {
    try {
      await store.remove();
    } catch {
      throw new CloudAuthOperationError("invalid cloud credentials could not be removed securely from this machine");
    }
    input.stdout("Removed an invalid local RoamCode Cloud session.\n");
    return 0;
  }
  if (!session) {
    input.stdout("Not signed in to RoamCode Cloud.\n");
    return 0;
  }
  let revokeError: unknown;
  try {
    await revokeSession(input, session);
  } catch (error) {
    revokeError = error;
  }
  try {
    await store.remove();
  } catch {
    throw new CloudAuthOperationError("cloud session could not be removed securely from this machine");
  }
  if (revokeError) {
    input.stderr(
      "Signed out locally, but the remote session could not be revoked. Review active sessions at roamcode.ai.\n",
    );
    return 1;
  }
  input.stdout("Signed out of RoamCode Cloud.\n");
  return 0;
}

async function runWhoAmI(
  input: CloudAuthCommandOptions,
  store: CloudCredentialStore,
  now: () => number,
): Promise<number> {
  let session = await store.read();
  if (!session) {
    input.stderr("Not signed in. Run `roamcode cloud login`.\n");
    return 1;
  }
  let refreshed = false;
  try {
    if (session.accessTokenExpiresAt <= now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
      session = await refreshSession(input, store, session, now);
      refreshed = true;
    }
    let result = await fetchIdentity(input, session);
    if (result.response.status === 401 && !refreshed) {
      session = await refreshSession(input, store, session, now);
      refreshed = true;
      result = await fetchIdentity(input, session);
    }
    if (!result.response.ok) {
      if (result.response.status === 401) {
        throw new CloudSessionExpiredError("cloud session expired; run `roamcode cloud login` again");
      }
      const code = oauthErrorCode(result.body);
      throw new CloudAuthOperationError(
        `cloud identity request failed (${result.response.status}${code ? ` ${code}` : ""})`,
      );
    }
    const identity = parseIdentity(result.body);
    input.stdout(
      [
        "Signed in to RoamCode Cloud.",
        `User: ${identity.user.name ? `${identity.user.name} <${identity.user.email}>` : identity.user.email}`,
        `Organization: ${identity.organization?.name ?? "Not selected"}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    if (error instanceof CloudSessionExpiredError) await store.remove().catch(() => undefined);
    throw error;
  }
}

/**
 * Resolve a usable CLI cloud session for another cloud command. Refresh rotation is serialized through the same
 * cross-process lock as login/logout, so `cloud connect` can never race `cloud whoami` and reuse a spent token.
 */
export async function getCloudAccessSession(
  input: CloudAuthCommandOptions,
  options: { forceRefresh?: boolean } = {},
): Promise<CloudAccessSession> {
  const now = input.now ?? Date.now;
  const processRunner = input.processRunner ?? runBoundedProcess;
  const platform = input.platform ?? process.platform;
  const uid = input.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const store =
    input.credentialStore ??
    createCloudCredentialStore({
      dataDir: input.dataDir,
      platform,
      processRunner,
      uid,
      pid: input.pid ?? process.pid,
      randomId: input.randomId,
    });
  let releaseOperationLock: (() => void) | undefined;
  try {
    if (!input.credentialStore) {
      releaseOperationLock = acquireCloudAuthOperationLock({
        dataDir: input.dataDir,
        lockDirectory: input.operationLockDirectory ?? (platform === "darwin" ? tmpdir() : input.dataDir),
        platform,
        uid,
      });
    }
    let session = await store.read();
    if (!session) throw new CloudAuthUsageError("not signed in; run `roamcode cloud login` first");
    if (options.forceRefresh || session.accessTokenExpiresAt <= now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
      session = await refreshSession(input, store, session, now);
    }
    return { controlPlaneOrigin: session.controlPlaneOrigin, accessToken: session.accessToken };
  } catch (error) {
    if (error instanceof CloudSessionExpiredError) await store.remove().catch(() => undefined);
    throw error;
  } finally {
    releaseOperationLock?.();
  }
}

export async function runCloudAuthCommand(input: CloudAuthCommandOptions): Promise<number> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const processRunner = input.processRunner ?? runBoundedProcess;
  const platform = input.platform ?? process.platform;
  const uid = input.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const store =
    input.credentialStore ??
    createCloudCredentialStore({
      dataDir: input.dataDir,
      platform,
      processRunner,
      uid,
      pid: input.pid ?? process.pid,
      randomId: input.randomId,
    });
  const openBrowser =
    input.openBrowser ??
    createBrowserOpener({
      platform,
      detachedProcessRunner: input.detachedProcessRunner ?? runDetachedProcess,
    });
  let releaseOperationLock: (() => void) | undefined;
  try {
    // Custom stores are test/application injection points with their own synchronization contract. The shipped
    // Keychain and file stores share this cross-process lock so refresh rotation, logout, and login are serialized.
    if (!input.credentialStore) {
      releaseOperationLock = acquireCloudAuthOperationLock({
        dataDir: input.dataDir,
        lockDirectory: input.operationLockDirectory ?? (platform === "darwin" ? tmpdir() : input.dataDir),
        platform,
        uid,
      });
    }
    if (input.options.cloudAction === "login") return await runLogin(input, store, openBrowser, now, sleep);
    if (input.options.cloudAction === "logout") return await runLogout(input, store);
    if (input.options.cloudAction === "whoami") return await runWhoAmI(input, store, now);
    throw new CloudAuthUsageError("unsupported cloud authentication action");
  } catch (error) {
    input.stderr(`${controlledError(error)}\n`);
    return error instanceof CloudAuthUsageError ? 2 : 1;
  } finally {
    releaseOperationLock?.();
  }
}

export async function runBoundedProcess(invocation: ProcessInvocation): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let child: ReturnType<typeof spawn>;
    const lifecycle: { timer?: NodeJS.Timeout } = {};
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (lifecycle.timer) clearTimeout(lifecycle.timer);
      resolve(result);
    };
    try {
      child = spawn(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        errorCode: (error as NodeJS.ErrnoException).code,
      });
      return;
    }
    const append = (current: string, chunk: Buffer): string => {
      if (overflow) return current;
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > invocation.maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ exitCode: null, stdout, stderr, errorCode: error.code, overflow }),
    );
    child.on("close", (exitCode) => finish({ exitCode, stdout, stderr, overflow }));
    if (invocation.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(invocation.stdin, "utf8");
    lifecycle.timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: null, stdout, stderr, timedOut: true, overflow });
    }, invocation.timeoutMs);
    lifecycle.timer.unref();
  });
}

export async function runDetachedProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function createBrowserOpener(input: {
  platform: NodeJS.Platform;
  detachedProcessRunner: DetachedProcessRunner;
}): BrowserOpener {
  return async (rawUrl: string) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    ) {
      return false;
    }
    const target = url.toString();
    const command =
      input.platform === "darwin"
        ? { executable: "open", args: [target] }
        : input.platform === "win32"
          ? { executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target] }
          : { executable: "xdg-open", args: [target] };
    try {
      await input.detachedProcessRunner(command.executable, command.args);
      return true;
    } catch {
      return false;
    }
  };
}

export interface CloudCredentialStoreOptions {
  dataDir: string;
  platform: NodeJS.Platform;
  processRunner: ProcessRunner;
  uid?: number;
  pid: number;
  randomId?: () => string;
}

function fsyncDirectory(path: string, platform: NodeJS.Platform): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && !(platform === "win32" && code === "EPERM")) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseOperationLockOwner(value: unknown): CloudAuthOperationLockOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    !Number.isSafeInteger(owner.createdAt) ||
    (owner.createdAt as number) <= 0 ||
    typeof owner.nonce !== "string" ||
    !/^[a-f0-9]{24}$/.test(owner.nonce)
  ) {
    return undefined;
  }
  return { pid: owner.pid as number, createdAt: owner.createdAt as number, nonce: owner.nonce };
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOperationLock(
  path: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
): { stat: Stats; owner?: CloudAuthOperationLockOwner } | undefined {
  const before = statOrUndefined(path);
  if (!before) return undefined;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_OPERATION_LOCK_BYTES ||
    (platform !== "win32" && (before.mode & 0o077) !== 0) ||
    (uid !== undefined && before.uid !== uid)
  ) {
    throw new CloudAuthOperationError("cloud authentication operation lock is unsafe");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_OPERATION_LOCK_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (platform !== "win32" && (opened.mode & 0o077) !== 0) ||
      (uid !== undefined && opened.uid !== uid)
    ) {
      throw new CloudAuthOperationError("cloud authentication operation lock changed while it was being inspected");
    }
    let owner: CloudAuthOperationLockOwner | undefined;
    try {
      owner = parseOperationLockOwner(JSON.parse(readFileSync(descriptor, "utf8")) as unknown);
    } catch {
      /* A creator may still be writing, or a crashed creator may have left an incomplete lock. */
    }
    return { stat: opened, ...(owner ? { owner } : {}) };
  } catch (error) {
    if (error instanceof CloudAuthOperationError) throw error;
    throw new CloudAuthOperationError("cloud authentication operation lock could not be inspected securely");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function acquireCloudAuthOperationLock(options: {
  dataDir: string;
  lockDirectory: string;
  platform: NodeJS.Platform;
  uid: number | undefined;
}): () => void {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(options.lockDirectory, { recursive: true, mode: 0o700 });
  const lockName =
    options.platform === "darwin" && options.lockDirectory !== options.dataDir
      ? `${CLOUD_AUTH_OPERATION_LOCK}.${options.uid ?? "current-user"}`
      : CLOUD_AUTH_OPERATION_LOCK;
  const path = join(options.lockDirectory, lockName);
  const owner: CloudAuthOperationLockOwner = {
    pid: process.pid,
    createdAt: Date.now(),
    nonce: randomBytes(12).toString("hex"),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      created = true;
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(options.lockDirectory, options.platform);

      return () => {
        try {
          const current = readOperationLock(path, options.platform, options.uid);
          if (!current?.owner || current.owner.nonce !== owner.nonce || current.owner.pid !== owner.pid) return;
          unlinkSync(path);
          fsyncDirectory(options.lockDirectory, options.platform);
        } catch {
          /* Best effort; an owner mismatch must never remove another process's lock. */
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (created) {
        try {
          unlinkSync(path);
          fsyncDirectory(options.lockDirectory, options.platform);
        } catch {
          /* The stable storage error below is more useful than cleanup details. */
        }
        throw new CloudAuthOperationError("cloud authentication operation lock could not be stored securely");
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new CloudAuthOperationError("cloud authentication operation lock could not be acquired securely");
      }

      const current = readOperationLock(path, options.platform, options.uid);
      if (!current) continue;
      const age = Date.now() - current.stat.mtimeMs;
      const active = age <= OPERATION_LOCK_STALE_MS && (!current.owner || processIsAlive(current.owner.pid));
      if (active) {
        throw new CloudAuthOperationError("another cloud authentication command is already running");
      }

      const latest = statOrUndefined(path);
      if (!latest) continue;
      if (latest.dev !== current.stat.dev || latest.ino !== current.stat.ino) continue;
      try {
        unlinkSync(path);
        fsyncDirectory(options.lockDirectory, options.platform);
      } catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new CloudAuthOperationError("stale cloud authentication operation lock could not be removed securely");
      }
    }
  }
  throw new CloudAuthOperationError("another cloud authentication command is already running");
}

function assertPrivateCredentialFile(
  path: string,
  stat: Stats,
  platform: NodeJS.Platform,
  uid: number | undefined,
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CloudAuthOperationError("cloud credential path must be a regular file, not a symlink");
  }
  if (stat.size > MAX_CREDENTIAL_BYTES) throw new CloudAuthOperationError("cloud credential file is too large");
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new CloudAuthOperationError("cloud credential file must be private (chmod 600)");
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new CloudAuthOperationError("cloud credential file must be owned by the current user");
  }
}

function createFileCredentialStore(options: CloudCredentialStoreOptions): CloudCredentialStore {
  const path = join(options.dataDir, CLOUD_AUTH_FILE);
  const read = async (): Promise<StoredCloudSession | undefined> => {
    const before = statOrUndefined(path);
    if (!before) return undefined;
    assertPrivateCredentialFile(path, before, options.platform, options.uid);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new CloudAuthOperationError("cloud credential file could not be opened securely");
    }
    try {
      const opened = fstatSync(descriptor);
      assertPrivateCredentialFile(path, opened, options.platform, options.uid);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new CloudAuthOperationError("cloud credential file changed while it was being opened");
      }
      try {
        return parseStoredSession(JSON.parse(readFileSync(descriptor, "utf8")) as unknown);
      } catch (error) {
        if (error instanceof CloudAuthOperationError) throw error;
        throw new CloudAuthOperationError(
          "saved cloud session is invalid; run `roamcode cloud logout` and sign in again",
        );
      }
    } finally {
      closeSync(descriptor);
    }
  };

  const remove = async (): Promise<boolean> => {
    const current = statOrUndefined(path);
    if (!current) return false;
    assertPrivateCredentialFile(path, current, options.platform, options.uid);
    try {
      unlinkSync(path);
      fsyncDirectory(dirname(path), options.platform);
      return true;
    } catch {
      throw new CloudAuthOperationError("cloud credential file could not be removed securely");
    }
  };

  return {
    read,
    write: async (session) => {
      const normalized = parseStoredSession(session);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const existing = statOrUndefined(path);
      if (existing) assertPrivateCredentialFile(path, existing, options.platform, options.uid);
      const randomId = options.randomId?.() ?? randomBytes(12).toString("hex");
      const temp = `${path}.${options.pid}.${randomId}.tmp`;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        fchmodSync(descriptor, 0o600);
        writeFileSync(descriptor, `${JSON.stringify(normalized)}\n`, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temp, path);
        fsyncDirectory(dirname(path), options.platform);
      } catch {
        if (descriptor !== undefined) closeSync(descriptor);
        try {
          unlinkSync(temp);
        } catch {
          /* Nothing safe remains to clean up. */
        }
        throw new CloudAuthOperationError("cloud credentials could not be stored in a private file");
      }
    },
    remove,
  };
}

type KeychainReadResult =
  { state: "value"; session: StoredCloudSession } | { state: "missing" } | { state: "unavailable" };

function createMacKeychain(options: CloudCredentialStoreOptions) {
  const run = (args: string[], stdin?: string) =>
    options.processRunner({
      command: "security",
      args,
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: 10_000,
      maxOutputBytes: MAX_CREDENTIAL_BYTES,
    });
  const ensureUsableResult = (result: ProcessResult, operation: string): "available" | "unavailable" => {
    if (result.errorCode === "ENOENT") return "unavailable";
    if (result.timedOut || result.overflow || result.exitCode === null) {
      throw new CloudAuthOperationError(`macOS Keychain could not ${operation}`);
    }
    return "available";
  };
  return {
    read: async (): Promise<KeychainReadResult> => {
      const result = await run(["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"]);
      if (ensureUsableResult(result, "be read") === "unavailable") return { state: "unavailable" };
      if (result.exitCode === 44) return { state: "missing" };
      if (result.exitCode !== 0) throw new CloudAuthOperationError("macOS Keychain could not be read");
      try {
        return { state: "value", session: parseStoredSession(JSON.parse(result.stdout.trim()) as unknown) };
      } catch (error) {
        if (error instanceof CloudAuthOperationError) throw error;
        throw new CloudAuthOperationError("saved macOS Keychain cloud session is invalid; sign in again");
      }
    },
    write: async (session: StoredCloudSession): Promise<"stored" | "unavailable"> => {
      const serialized = `${JSON.stringify(parseStoredSession(session))}\n`;
      const result = await run(
        ["add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-U", "-w"],
        serialized,
      );
      if (ensureUsableResult(result, "store credentials") === "unavailable") return "unavailable";
      if (result.exitCode !== 0) throw new CloudAuthOperationError("macOS Keychain could not store credentials");
      return "stored";
    },
    remove: async (): Promise<"removed" | "missing" | "unavailable"> => {
      const result = await run(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
      if (ensureUsableResult(result, "remove credentials") === "unavailable") return "unavailable";
      if (result.exitCode === 44) return "missing";
      if (result.exitCode !== 0) throw new CloudAuthOperationError("macOS Keychain could not remove credentials");
      return "removed";
    },
  };
}

export function createCloudCredentialStore(options: CloudCredentialStoreOptions): CloudCredentialStore {
  const file = createFileCredentialStore(options);
  if (options.platform !== "darwin") return file;
  const keychain = createMacKeychain(options);
  return {
    read: async () => {
      const result = await keychain.read();
      if (result.state === "value") return result.session;
      return file.read();
    },
    write: async (session) => {
      const result = await keychain.write(session);
      if (result === "unavailable") {
        await file.write(session);
        return;
      }
      await file.remove().catch(() => undefined);
    },
    remove: async () => {
      const result = await keychain.remove();
      const removedFile = await file.remove();
      return result === "removed" || removedFile;
    },
  };
}
