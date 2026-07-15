import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { CliOptions } from "./args.js";

export const API_ACTIONS = [
  "capabilities",
  "attention",
  "sessions",
  "agents",
  "workspaces",
  "devices",
  "team",
  "members",
  "policy",
  "fleet",
  "peers",
  "peer-workspaces",
  "peer-agents",
  "peer-sessions",
  "peer-add",
  "peer-update",
  "peer-verify",
  "peer-discover",
  "peer-rotate",
  "peer-remove",
  "presence",
  "adapters",
  "extensions",
  "plugins",
  "automations",
  "events",
  "audit",
  "audit-verify",
  "audit-export",
  "openapi",
  "lease",
  "send",
  "wait",
  "focus",
  "start",
] as const;

type ApiAction = (typeof API_ACTIONS)[number];

export interface ApiCommandOptions {
  options: CliOptions;
  env: NodeJS.ProcessEnv;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  generateIdempotencyKey?: () => string;
}

function safeId(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`${label} must be a valid id`);
  return value;
}

const PEER_ACTIONS = ["read", "wait", "send", "start", "focus"] as const;
const MAX_CREDENTIAL_FILE_BYTES = 4_096;
const MAX_PAIRING_FILE_BYTES = 8_192;

function readPrivatePeerFile(path: string, kind: "credential" | "pairing", maxBytes: number): string {
  const prefix = `peer ${kind}`;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`${prefix} path must be a regular file, not a symlink`);
    }
    if (before.size > maxBytes) throw new Error(`${prefix} file is too large`);
    if ((before.mode & 0o077) !== 0) throw new Error(`${prefix} file must be private (chmod 600)`);
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error(`${prefix} file must be owned by the current user`);
    }
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`${prefix} file changed while it was being opened`);
      }
      return readFileSync(descriptor, "utf8").trim();
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(prefix)) throw error;
    throw new Error(`${prefix} file could not be read securely`);
  }
}

/** Read a peer credential without following symlinks or accepting a file readable by another local user. */
export function readPeerCredential(path: string): string {
  const credential = readPrivatePeerFile(path, "credential", MAX_CREDENTIAL_FILE_BYTES);
  if (
    credential.length < 16 ||
    credential.length > MAX_CREDENTIAL_FILE_BYTES ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(credential)
  ) {
    throw new Error("peer credential file does not contain a valid bearer credential");
  }
  return credential;
}

/** Read and validate a one-use pairing link without ever accepting it as a process argument. */
export function readPeerPairingUrl(path: string): string {
  const value = readPrivatePeerFile(path, "pairing", MAX_PAIRING_FILE_BYTES);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("peer pairing file does not contain a valid one-use link");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  const entries = [...new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash).entries()];
  const secret = entries.length === 1 && entries[0]?.[0] === "pair" ? entries[0][1] : undefined;
  if (
    url.username ||
    url.password ||
    url.search ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    !secret ||
    !/^rcp_[A-Za-z0-9_-]{43}$/.test(secret)
  ) {
    throw new Error("peer pairing file does not contain a valid one-use link");
  }
  return value;
}

function peerCredential(options: CliOptions, env: NodeJS.ProcessEnv): string | undefined {
  const path = options.peerCredentialFile ?? env.ROAMCODE_PEER_CREDENTIAL_FILE;
  return path ? readPeerCredential(path) : undefined;
}

function peerPairingUrl(options: CliOptions, env: NodeJS.ProcessEnv): string | undefined {
  const path = options.peerPairingFile ?? env.ROAMCODE_PEER_PAIRING_FILE;
  return path ? readPeerPairingUrl(path) : undefined;
}

function peerAccess(options: CliOptions, env: NodeJS.ProcessEnv, includeOrigin: boolean): Record<string, string> {
  const pairingUrl = peerPairingUrl(options, env);
  const credential = peerCredential(options, env);
  if (pairingUrl && credential) {
    throw new Error("peer access accepts either a pairing file or a credential file, not both");
  }
  if (pairingUrl) return { pairingUrl };
  if (credential) return { ...(includeOrigin ? { baseUrl: peerOrigin(options.peerUrl) } : {}), credential };
  throw new Error(
    "peer access requires --peer-pairing-file or --peer-credential-file (or the matching file environment variable)",
  );
}

function peerOrigin(value: string | undefined): string {
  if (!value) throw new Error("peer registration requires --peer-url");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("--peer-url must be a valid HTTPS origin");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("--peer-url must be an HTTPS origin; plain HTTP is allowed only on loopback");
  }
  return url.origin;
}

function parsePeerActions(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const actions = [...new Set(value.split(",").map((item) => item.trim()))];
  if (actions.length < 1 || actions.some((action) => !PEER_ACTIONS.includes(action as (typeof PEER_ACTIONS)[number]))) {
    throw new Error(`--actions must be a comma-separated subset of ${PEER_ACTIONS.join(",")}`);
  }
  return PEER_ACTIONS.filter((action) => actions.includes(action));
}

function parsePeerWorkspaces(value: string | undefined): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "*") return null;
  const ids = [...new Set(value.split(",").map((item) => safeId(item.trim(), "--workspaces")))];
  if (ids.length < 1 || ids.length > 1_000) throw new Error("--workspaces must contain 1-1000 workspace ids or *");
  return ids.sort();
}

function baseUrl(options: CliOptions, env: NodeJS.ProcessEnv): URL {
  const value = options.publicUrl ?? env.ROAMCODE_API_URL ?? "http://127.0.0.1:4280";
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("ROAMCODE_API_URL must be an http(s) origin without credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function parseNonNegative(value: string | undefined, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`${label} must be 0-${max}`);
  return parsed;
}

function parseOptionsJson(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--options-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requestFor(
  action: ApiAction,
  options: CliOptions,
  env: NodeJS.ProcessEnv,
): { method: string; path: string; body?: unknown; waitMs?: number; responseFormat?: "json" | "text" } {
  switch (action) {
    case "capabilities":
      return { method: "GET", path: "/api/v1/capabilities" };
    case "attention":
    case "sessions":
    case "agents":
    case "workspaces":
    case "devices":
    case "team":
    case "policy":
    case "fleet":
    case "presence":
    case "adapters":
    case "extensions":
    case "plugins":
    case "automations":
      return { method: "GET", path: `/api/v1/${action}` };
    case "peers":
      return { method: "GET", path: "/api/v1/peers" };
    case "peer-workspaces":
    case "peer-agents":
    case "peer-sessions": {
      const peerId = safeId(options.peerId, "--peer");
      return { method: "GET", path: `/api/v1/peers/${encodeURIComponent(peerId)}/${action.slice(5)}` };
    }
    case "peer-add": {
      if (!options.confirm) throw new Error("api peer-add requires --confirm before storing cross-host access");
      const actions = parsePeerActions(options.actions);
      const allowedWorkspaceIds = parsePeerWorkspaces(options.workspaces);
      return {
        method: "POST",
        path: "/api/v1/peers",
        body: {
          ...peerAccess(options, env, true),
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(actions === undefined ? {} : { actions }),
          ...(allowedWorkspaceIds === undefined ? {} : { allowedWorkspaceIds }),
          confirm: true,
        },
      };
    }
    case "peer-update": {
      const peerId = safeId(options.peerId, "--peer");
      const expectedRevision = parseNonNegative(
        options.expectedRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "--expected-revision",
      );
      if (expectedRevision < 1) throw new Error("api peer-update requires --expected-revision");
      const actions = parsePeerActions(options.actions);
      const allowedWorkspaceIds = parsePeerWorkspaces(options.workspaces);
      const status = options.peerStatus;
      if (status !== undefined && status !== "active" && status !== "suspended") {
        throw new Error("--peer-status must be active or suspended");
      }
      if (
        options.label === undefined &&
        actions === undefined &&
        allowedWorkspaceIds === undefined &&
        status === undefined
      ) {
        throw new Error("api peer-update requires --label, --actions, --workspaces, or --peer-status");
      }
      return {
        method: "PATCH",
        path: `/api/v1/peers/${encodeURIComponent(peerId)}`,
        body: {
          expectedRevision,
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(actions === undefined ? {} : { actions }),
          ...(allowedWorkspaceIds === undefined ? {} : { allowedWorkspaceIds }),
          ...(status === undefined ? {} : { status }),
        },
      };
    }
    case "peer-verify": {
      const peerId = safeId(options.peerId, "--peer");
      const expectedRevision = parseNonNegative(
        options.expectedRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "--expected-revision",
      );
      if (expectedRevision < 1) throw new Error("api peer-verify requires --expected-revision");
      return {
        method: "POST",
        path: `/api/v1/peers/${encodeURIComponent(peerId)}/verify`,
        body: { expectedRevision },
      };
    }
    case "peer-discover": {
      const peerId = safeId(options.peerId, "--peer");
      const expectedRevision = parseNonNegative(
        options.expectedRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "--expected-revision",
      );
      if (expectedRevision < 1) throw new Error("api peer-discover requires --expected-revision");
      return {
        method: "POST",
        path: `/api/v1/peers/${encodeURIComponent(peerId)}/discover`,
        body: { expectedRevision },
      };
    }
    case "peer-rotate": {
      const peerId = safeId(options.peerId, "--peer");
      const expectedRevision = parseNonNegative(
        options.expectedRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "--expected-revision",
      );
      if (expectedRevision < 1) throw new Error("api peer-rotate requires --expected-revision");
      if (!options.confirm) throw new Error("api peer-rotate requires --confirm");
      return {
        method: "POST",
        path: `/api/v1/peers/${encodeURIComponent(peerId)}/credential`,
        body: { ...peerAccess(options, env, false), expectedRevision, confirm: true },
      };
    }
    case "peer-remove": {
      const peerId = safeId(options.peerId, "--peer");
      if (!options.confirm) throw new Error("api peer-remove requires --confirm");
      return {
        method: "DELETE",
        path: `/api/v1/peers/${encodeURIComponent(peerId)}`,
        body: { confirm: true },
      };
    }
    case "members":
      return { method: "GET", path: "/api/v1/team/members" };
    case "openapi":
      return { method: "GET", path: "/api/v1/openapi.json" };
    case "events": {
      const after = parseNonNegative(options.after, 0, Number.MAX_SAFE_INTEGER, "--after");
      return { method: "GET", path: `/api/v1/events?after=${after}` };
    }
    case "audit":
    case "audit-export": {
      const after = parseNonNegative(options.after, 0, Number.MAX_SAFE_INTEGER, "--after");
      const limit = parseNonNegative(options.limit, 500, 1000, "--limit");
      if (limit < 1) throw new Error("--limit must be 1-1000");
      return {
        method: "GET",
        path: `/api/v1/audit${action === "audit-export" ? "/export" : ""}?after=${after}&limit=${limit}`,
        ...(action === "audit-export" ? { responseFormat: "text" as const } : {}),
      };
    }
    case "audit-verify":
      return { method: "GET", path: "/api/v1/audit/verify" };
    case "send": {
      const sessionId = safeId(options.sessionId, "--session");
      const peerId = options.peerId === undefined ? undefined : safeId(options.peerId, "--peer");
      if (options.data === undefined) throw new Error("api send requires --data");
      if ((options.clientId === undefined) !== (options.leaseId === undefined)) {
        throw new Error("api send requires --client and --lease together");
      }
      return {
        method: "POST",
        path: peerId
          ? `/api/v1/peers/${encodeURIComponent(peerId)}/sessions/${encodeURIComponent(sessionId)}/input`
          : `/api/v1/sessions/${encodeURIComponent(sessionId)}/input`,
        body: {
          data: options.data,
          ...(options.appendNewline ? { appendNewline: true } : {}),
          ...(options.clientId && options.leaseId
            ? { clientId: safeId(options.clientId, "--client"), leaseId: safeId(options.leaseId, "--lease") }
            : {}),
        },
      };
    }
    case "lease": {
      const sessionId = safeId(options.sessionId, "--session");
      const peerId = options.peerId === undefined ? undefined : safeId(options.peerId, "--peer");
      const selected = [options.takeover, options.renew, options.release, options.revoke].filter(Boolean).length;
      if (selected > 1) throw new Error("choose only one of --takeover, --renew, --release, or --revoke");
      const action = options.takeover
        ? "takeover"
        : options.renew
          ? "renew"
          : options.release
            ? "release"
            : options.revoke
              ? "revoke"
              : "acquire";
      if ((action === "takeover" || action === "revoke") && !options.confirm) {
        throw new Error(`api lease --${action} requires --confirm`);
      }
      if ((action === "renew" || action === "release") && options.leaseId === undefined) {
        throw new Error(`api lease --${action} requires --lease`);
      }
      const clientId = action === "revoke" ? undefined : safeId(options.clientId, "--client");
      return {
        method: "POST",
        path: peerId
          ? `/api/v1/peers/${encodeURIComponent(peerId)}/sessions/${encodeURIComponent(sessionId)}/input-lease`
          : `/api/v1/sessions/${encodeURIComponent(sessionId)}/input-lease`,
        body: {
          action,
          ...(clientId ? { clientId } : {}),
          ...(options.leaseId ? { leaseId: safeId(options.leaseId, "--lease") } : {}),
          ...(action === "takeover" || action === "revoke" ? { confirm: true } : {}),
        },
      };
    }
    case "wait": {
      const agentId = safeId(options.agentId, "--agent");
      const peerId = options.peerId === undefined ? undefined : safeId(options.peerId, "--peer");
      const timeoutMs = parseNonNegative(options.timeoutMs, 30_000, 30_000, "--timeout-ms");
      const after = parseNonNegative(options.after, 0, Number.MAX_SAFE_INTEGER, "--after");
      return {
        method: "GET",
        path: peerId
          ? `/api/v1/peers/${encodeURIComponent(peerId)}/agents/${encodeURIComponent(agentId)}/wait?after=${after}&timeoutMs=${timeoutMs}`
          : `/api/v1/agents/${encodeURIComponent(agentId)}/wait?after=${after}&timeoutMs=${timeoutMs}`,
        waitMs: timeoutMs,
      };
    }
    case "focus": {
      const agentId = safeId(options.agentId, "--agent");
      const peerId = options.peerId === undefined ? undefined : safeId(options.peerId, "--peer");
      return {
        method: "POST",
        path: peerId
          ? `/api/v1/peers/${encodeURIComponent(peerId)}/agents/${encodeURIComponent(agentId)}/focus`
          : `/api/v1/agents/${encodeURIComponent(agentId)}/focus`,
        body: { mode: options.activate ? "activate" : "request" },
      };
    }
    case "start": {
      const peerId = options.peerId === undefined ? undefined : safeId(options.peerId, "--peer");
      const provider = options.provider ?? "claude";
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new Error("--provider must be a safe adapter id");
      if (peerId) {
        const workspaceId = safeId(options.workspaceId, "--workspace");
        if (options.cwd !== undefined) throw new Error("api start with --peer accepts --workspace, not --cwd");
        return {
          method: "POST",
          path: `/api/v1/peers/${encodeURIComponent(peerId)}/sessions`,
          body: { workspaceId, provider, options: parseOptionsJson(options.optionsJson) },
        };
      }
      if (!options.cwd) throw new Error("api start requires --cwd");
      return {
        method: "POST",
        path: "/api/v1/sessions",
        body: { cwd: options.cwd, provider, options: parseOptionsJson(options.optionsJson) },
      };
    }
  }
}

export async function runApiCommand(input: ApiCommandOptions): Promise<number> {
  try {
    const action = input.options.apiAction;
    if (!action || !API_ACTIONS.includes(action as ApiAction)) {
      throw new Error(`api action must be one of: ${API_ACTIONS.join(", ")}`);
    }
    const token = input.env.ROAMCODE_API_TOKEN;
    if (!token || token.length > 4096 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(token)) {
      throw new Error("ROAMCODE_API_TOKEN is required and must be a valid bearer credential");
    }
    const request = requestFor(action as ApiAction, input.options, input.env);
    const origin = baseUrl(input.options, input.env);
    const url = new URL(request.path, `${origin.href.replace(/\/$/, "")}/`);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: request.responseFormat === "text" ? "application/x-ndjson" : "application/json",
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers["idempotency-key"] = input.options.idempotencyKey ?? (input.generateIdempotencyKey ?? randomUUID)();
    }
    const response = await (input.fetch ?? globalThis.fetch)(url, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout((request.waitMs ?? 10_000) + 5_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const error = JSON.parse(text) as { code?: unknown; error?: unknown };
        if (typeof error.code === "string" || typeof error.error === "string") {
          message = [error.code, error.error].filter((item): item is string => typeof item === "string").join(": ");
        }
      } catch {
        /* never echo an arbitrary HTML/proxy body into an agent transcript */
      }
      input.stderr(`RoamCode API request failed: ${message.slice(0, 320)}\n`);
      return 1;
    }
    if (response.status === 204 || text.length === 0) input.stdout('{"ok":true}\n');
    else if (request.responseFormat === "text") input.stdout(text.endsWith("\n") ? text : `${text}\n`);
    else {
      const parsed = JSON.parse(text) as unknown;
      input.stdout(`${JSON.stringify(parsed, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    input.stderr(`${(error as Error).message}\n`);
    return 2;
  }
}
