import { normalizePeerBaseUrl, type PeerConnection } from "./peer-store.js";

const MAX_PEER_RESPONSE_BYTES = 2 * 1024 * 1024;
const PEER_REQUEST_TIMEOUT_MS = 15_000;

export interface VerifiedPeerIdentity {
  remoteHostId: string;
  remoteVersion: string;
  remoteLabel: string;
  protocolVersion: number;
}

export interface PeerJsonResponse {
  status: number;
  body: unknown;
}

export interface ClaimedPeerCredential {
  baseUrl: string;
  credential: string;
  deviceId: string;
}

export class PeerRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly remoteCode?: string,
  ) {
    super(message);
    this.name = "PeerRequestError";
  }
}

function safeRemoteText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized) ? normalized : undefined;
}

async function boundedText(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_PEER_RESPONSE_BYTES) {
    throw new PeerRequestError("peer returned an oversized response", response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PEER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PeerRequestError("peer returned an oversized response", response.status);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PeerRequestError("peer returned an invalid JSON response", status);
  }
}

export function parsePeerPairingUrl(value: unknown): { baseUrl: string; secret: string } {
  if (typeof value !== "string" || value.length > 8_192) throw new PeerRequestError("invalid peer pairing link");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PeerRequestError("invalid peer pairing link");
  }
  let baseUrl: string;
  try {
    baseUrl = normalizePeerBaseUrl(url.origin);
  } catch {
    throw new PeerRequestError("invalid peer pairing link");
  }
  if (url.username || url.password || url.search || (url.pathname !== "/" && url.pathname !== "")) {
    throw new PeerRequestError("invalid peer pairing link");
  }
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const entries = [...params.entries()];
  const secret = entries.length === 1 && entries[0]?.[0] === "pair" ? entries[0][1] : undefined;
  if (!secret || !/^rcp_[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new PeerRequestError("invalid peer pairing link");
  }
  return { baseUrl, secret };
}

export async function claimPeerPairing(input: {
  pairingUrl: string;
  deviceName: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<ClaimedPeerCredential> {
  const parsed = parsePeerPairingUrl(input.pairingUrl);
  const deviceName = safeRemoteText(input.deviceName, 80);
  if (!deviceName) throw new PeerRequestError("invalid peer device name");
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(new URL("/pairing/claim", `${parsed.baseUrl}/`), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ secret: parsed.secret, name: deviceName }),
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PeerRequestError("peer host is unreachable");
  }
  const text = await boundedText(response);
  if (!response.ok) throw new PeerRequestError("peer pairing was rejected", response.status);
  const body = parseJson(text, response.status);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PeerRequestError("peer pairing response is invalid", 422);
  }
  const record = body as Record<string, unknown>;
  const device = record.device;
  const credential = safeRemoteText(record.token, 80);
  const deviceId =
    device && typeof device === "object" && !Array.isArray(device)
      ? safeRemoteText((device as Record<string, unknown>).id, 128)
      : undefined;
  if (!credential || !/^rcd_[A-Za-z0-9_-]{43}$/.test(credential) || !deviceId || !/^[A-Za-z0-9_-]+$/.test(deviceId)) {
    throw new PeerRequestError("peer pairing response is invalid", 422);
  }
  return { baseUrl: parsed.baseUrl, credential, deviceId };
}

/** Best-effort cleanup for a freshly claimed credential when verification or local persistence fails. */
export async function revokeClaimedPeerDevice(input: {
  baseUrl: string;
  credential: string;
  deviceId: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId)) return false;
  try {
    const response = await (input.fetch ?? globalThis.fetch)(
      new URL(`/devices/${encodeURIComponent(input.deviceId)}`, `${input.baseUrl}/`),
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${input.credential}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(input.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS),
      },
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function requestPeerJson(
  connection: Pick<PeerConnection, "baseUrl" | "credential">,
  path: string,
  init: {
    method?: "GET" | "POST";
    body?: unknown;
    idempotencyKey?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {},
): Promise<PeerJsonResponse> {
  if (!path.startsWith("/api/v1/") || path.includes("\\") || /%2f|%5c/i.test(path)) {
    throw new PeerRequestError("invalid peer API path");
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${connection.credential}`,
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let response: Response;
  try {
    response = await (init.fetch ?? globalThis.fetch)(new URL(path, `${connection.baseUrl}/`), {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PeerRequestError("peer host is unreachable");
  }
  const text = await boundedText(response);
  if (!response.ok) {
    let code: string | undefined;
    let detail: string | undefined;
    if (text) {
      try {
        const parsed = parseJson(text, response.status) as { code?: unknown; error?: unknown };
        code = safeRemoteText(parsed?.code, 96);
        detail = safeRemoteText(parsed?.error, 160);
      } catch {
        /* A compromised proxy body is never echoed into local API/audit output. */
      }
    }
    throw new PeerRequestError(
      detail ? `peer rejected the request: ${detail}` : "peer rejected the request",
      response.status,
      code,
    );
  }
  if (response.status === 204 || text.length === 0) return { status: response.status, body: { ok: true } };
  return { status: response.status, body: parseJson(text, response.status) };
}

export async function verifyPeerConnection(input: {
  baseUrl: string;
  credential: string;
  localHostId: string;
  fetch?: typeof globalThis.fetch;
}): Promise<VerifiedPeerIdentity> {
  const response = await requestPeerJson(input, "/api/v1/capabilities", { fetch: input.fetch });
  if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
    throw new PeerRequestError("peer capabilities are invalid", 422);
  }
  const body = response.body as Record<string, unknown>;
  const host = body.host;
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    throw new PeerRequestError("peer capabilities are invalid", 422);
  }
  const hostRecord = host as Record<string, unknown>;
  const remoteHostId = safeRemoteText(hostRecord.id, 256);
  const remoteLabel = safeRemoteText(hostRecord.label, 80);
  const remoteVersion = safeRemoteText(body.serverVersion, 64);
  if (
    body.protocolVersion !== 1 ||
    !remoteHostId ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(remoteHostId) ||
    !remoteLabel ||
    !remoteVersion ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(remoteVersion)
  ) {
    throw new PeerRequestError("peer capabilities are incompatible", 422);
  }
  if (remoteHostId === input.localHostId) {
    throw new PeerRequestError("a host cannot register itself as a peer", 422);
  }
  return { remoteHostId, remoteVersion, remoteLabel, protocolVersion: 1 };
}
