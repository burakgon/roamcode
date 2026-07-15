import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import {
  generateRelayCredential,
  normalizeRelayAppUrl,
  readRelayHostConfig,
  readServiceRecord,
  relayCredentialHash,
  removeRelayHostConfig,
  resolveDataDir,
  restartService,
  writeRelayHostConfig,
  type PersistedRelayHostConfig,
  type RelayHostConfigInput,
  type ServiceRecord,
} from "@roamcode.ai/server";
import type { CliOptions } from "./args.js";

export const CLOUD_ACTIONS = ["connect", "status", "rotate", "disconnect"] as const;
type CloudAction = (typeof CLOUD_ACTIONS)[number];

const DEFAULT_CLOUD_URL = "https://relay.roamcode.ai";
const DEFAULT_CLOUD_APP_URL = "https://app.roamcode.ai";
const MAX_CREDENTIAL_FILE_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 64 * 1_024;

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
  readConfig?: (dataDir: string) => PersistedRelayHostConfig | undefined;
  writeConfig?: (dataDir: string, input: RelayHostConfigInput) => PersistedRelayHostConfig;
  removeConfig?: (dataDir: string) => boolean;
  readInstalledService?: (dataDir: string) => ServiceRecord | undefined;
  restartInstalledService?: (record: ServiceRecord) => RestartResult;
}

interface CloudRouteResponse {
  route: { id: string };
}

interface CloudRouteStatus {
  routeId: string;
  hostOnline: boolean;
  activeDevices: number;
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

function apiOriginForConfig(config: PersistedRelayHostConfig): string {
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
  if (!label || label.length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label)) {
    throw new CloudUsageError("cloud host label must be 1-80 printable characters");
  }
  return label;
}

function assertNoEnvironmentOverride(env: NodeJS.ProcessEnv): void {
  if (env.ROAMCODE_RELAY_URL || env.ROAMCODE_RELAY_ROUTE_ID || env.ROAMCODE_RELAY_HOST_CREDENTIAL) {
    throw new CloudUsageError(
      "ROAMCODE_RELAY_URL/ROUTE_ID/HOST_CREDENTIAL override managed cloud settings; remove them before using this command",
    );
  }
}

/** Read a bearer credential without following symlinks or accepting group/world-readable files. */
export function readCloudAccountCredential(path: string): string {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new CloudUsageError("cloud account credential path must be a regular file, not a symlink");
    }
    if (before.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new CloudUsageError("cloud account credential file is too large");
    }
    if ((before.mode & 0o077) !== 0) {
      throw new CloudUsageError("cloud account credential file must be private (chmod 600)");
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new CloudUsageError("cloud account credential file must be owned by the current user");
    }
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.size > MAX_CREDENTIAL_FILE_BYTES ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      ) {
        throw new CloudUsageError("cloud account credential file changed while it was being opened");
      }
      const credential = readFileSync(descriptor, "utf8").trim();
      if (!/^rrk_[A-Za-z0-9_-]{43}$/.test(credential)) {
        throw new CloudUsageError("cloud account credential file does not contain a valid account credential");
      }
      return credential;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof CloudUsageError) throw error;
    throw new CloudUsageError("cloud account credential file could not be read securely");
  }
}

function accountCredential(options: CliOptions, env: NodeJS.ProcessEnv): string {
  const path = options.accountTokenFile ?? env.ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE;
  if (!path) {
    throw new CloudUsageError(
      "cloud account access requires --account-token-file or ROAMCODE_CLOUD_ACCOUNT_TOKEN_FILE",
    );
  }
  return readCloudAccountCredential(path);
}

function safeRemoteMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= 160 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized) ? normalized : undefined;
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  origin: string,
  path: string,
  credential: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
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
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CloudOperationError("could not reach the cloud relay");
  }
  const announcedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedLength) && announcedLength > MAX_RESPONSE_BYTES) {
    throw new CloudOperationError("cloud relay returned an oversized response", response.status);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new CloudOperationError("cloud relay returned an oversized response", response.status);
  }
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
      const code = safeRemoteMessage(parsed.code);
      const message = safeRemoteMessage(parsed.error);
      detail = [code, message].filter(Boolean).join(": ") || undefined;
    } catch {
      /* Never echo an arbitrary proxy/HTML body into a terminal transcript. */
    }
    throw new CloudOperationError(
      `cloud relay request failed (${response.status}${detail ? ` ${detail}` : ""})`,
      response.status,
    );
  }
  if (response.status === 204 || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudOperationError("cloud relay returned an invalid response", response.status);
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

export async function runCloudCommand(input: CloudCommandOptions): Promise<number> {
  const readConfig = input.readConfig ?? readRelayHostConfig;
  const writeConfig = input.writeConfig ?? writeRelayHostConfig;
  const removeConfig = input.removeConfig ?? removeRelayHostConfig;
  const readInstalled = input.readInstalledService ?? readServiceRecord;
  const restartInstalled = input.restartInstalledService ?? restartService;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const dataDir = input.dataDir ?? resolveDataDir(input.env);

  try {
    const action = input.options.cloudAction;
    if (!action || !CLOUD_ACTIONS.includes(action as CloudAction)) {
      throw new CloudUsageError(`cloud action must be one of: ${CLOUD_ACTIONS.join(", ")}`);
    }
    assertNoEnvironmentOverride(input.env);

    if (action === "connect") {
      if (readConfig(dataDir)) {
        throw new CloudUsageError(
          "cloud access is already configured; disconnect it before provisioning another route",
        );
      }
      const credential = accountCredential(input.options, input.env);
      const origin = cloudOrigin(input.options.publicUrl ?? input.env.ROAMCODE_CLOUD_URL ?? DEFAULT_CLOUD_URL);
      const appUrl = normalizeRelayAppUrl(
        input.options.appUrl ?? input.env.ROAMCODE_CLOUD_APP_URL ?? DEFAULT_CLOUD_APP_URL,
      );
      const label = safeLabel(input.options.label ?? input.env.ROAMCODE_CLOUD_HOST_LABEL);
      const routeId = (input.generateRouteId ?? (() => `rrt_${randomBytes(18).toString("base64url")}`))();
      if (!/^rrt_[A-Za-z0-9_-]{16,128}$/.test(routeId)) {
        throw new CloudOperationError("could not generate a valid cloud route identity");
      }
      const hostCredential = (input.generateHostCredential ?? (() => generateRelayCredential("rrh")))();
      let provisioned = false;
      try {
        const response = await requestJson(fetchImpl, origin, "/v1/account/routes", credential, {
          method: "POST",
          body: { id: routeId, label, credentialHash: relayCredentialHash(hostCredential) },
        });
        parseRouteResponse(response, routeId);
        provisioned = true;
      } catch (error) {
        const cleaned = await bestEffortDelete(fetchImpl, origin, routeId, credential);
        if (!cleaned && error instanceof CloudOperationError && error.status === undefined) {
          throw new CloudOperationError(
            "cloud route provisioning could not be confirmed; retry after checking the account route inventory",
          );
        }
        throw error;
      }
      try {
        writeConfig(dataDir, { relayUrl: origin, routeId, hostCredential, appUrl, hostLabel: label });
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
    if (!config) {
      if (action === "status") {
        input.stdout("Cloud access is not configured.\n");
        return 1;
      }
      throw new CloudUsageError("cloud access is not configured; run `roamcode cloud connect` first");
    }
    const origin = apiOriginForConfig(config);

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
      writeConfig(dataDir, nextConfig);
      try {
        await requestJson(
          fetchImpl,
          origin,
          `/v1/account/routes/${encodeURIComponent(config.routeId)}/credential`,
          credential,
          { method: "POST", body: { credentialHash: relayCredentialHash(nextHostCredential) } },
        );
      } catch (error) {
        try {
          writeConfig(dataDir, config);
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
      removeConfig(dataDir);
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
