/** RPC uses JSON inside an encrypted frame inside a base64 relay envelope. Larger data uses chunked streams. */
export const RELAY_RPC_MAX_BODY_BYTES = 256 * 1024;
export const RELAY_RPC_MAX_PATH_BYTES = 4096;

export type RelayRpcMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RelayRpcRequest {
  id: string;
  method: RelayRpcMethod;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface RelayRpcResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body?: string;
}

const METHODS = new Set<RelayRpcMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "idempotency-key",
  "if-none-match",
  "if-range",
  "last-event-id",
  "range",
]);
const RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "idempotency-replayed",
  "retry-after",
]);

function safeId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error("invalid relay RPC id");
  return value;
}

function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Buffer.byteLength(value) > RELAY_RPC_MAX_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("invalid relay RPC path");
  }
  try {
    const url = new URL(value, "http://relay.internal");
    if (url.origin !== "http://relay.internal" || `${url.pathname}${url.search}` !== value || url.hash) {
      throw new Error("invalid relay RPC path");
    }
  } catch {
    throw new Error("invalid relay RPC path");
  }
  return value;
}

function headersFrom(value: unknown, allowed: ReadonlySet<string>): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay RPC headers");
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.toLowerCase();
    if (name !== rawName || !allowed.has(name) || typeof rawValue !== "string" || Buffer.byteLength(rawValue) > 2048) {
      throw new Error("invalid relay RPC headers");
    }
    if (/[\r\n\u0000]/.test(rawValue)) throw new Error("invalid relay RPC headers");
    output[name] = rawValue;
  }
  return output;
}

function bodyFrom(value: unknown): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid relay RPC body");
  const body = Buffer.from(value, "base64url");
  if (body.byteLength > RELAY_RPC_MAX_BODY_BYTES || body.toString("base64url") !== value) {
    throw new Error("invalid relay RPC body");
  }
  return body;
}

export function parseRelayRpcRequest(value: unknown): RelayRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid relay RPC request");
  const request = value as Record<string, unknown>;
  if (typeof request.method !== "string" || !METHODS.has(request.method as RelayRpcMethod)) {
    throw new Error("invalid relay RPC method");
  }
  const body = bodyFrom(request.body);
  if ((request.method === "GET" || request.method === "HEAD") && body) throw new Error("invalid relay RPC body");
  return {
    id: safeId(request.id),
    method: request.method as RelayRpcMethod,
    path: safePath(request.path),
    headers: headersFrom(request.headers, REQUEST_HEADERS),
    ...(body ? { body } : {}),
  };
}

export function relayRpcResponse(input: {
  id: string;
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body?: Uint8Array;
}): RelayRpcResponse {
  if (!Number.isSafeInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new Error("invalid relay RPC response status");
  }
  if (input.body && input.body.byteLength > RELAY_RPC_MAX_BODY_BYTES) {
    throw new Error("relay RPC response body is too large");
  }
  const rawHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!RESPONSE_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    rawHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return {
    id: safeId(input.id),
    status: input.status,
    headers: headersFrom(rawHeaders, RESPONSE_HEADERS),
    ...(input.body && input.body.byteLength > 0 ? { body: Buffer.from(input.body).toString("base64url") } : {}),
  };
}
