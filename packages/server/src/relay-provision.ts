import { relayConnectUrl } from "./relay-host.js";

const RESPONSE_LIMIT = 16 * 1024;
const UNSAFE_TERMINAL_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface RelayDeviceProvisioner {
  putDevice(deviceId: string, credentialHash: string, expiresAt?: number): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
}

export interface RelayDeviceProvisionerOptions {
  relayUrl: string;
  routeId: string;
  hostCredential: string;
  request?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`invalid relay ${field}`);
  return value;
}

function relayHttpOrigin(raw: string): string {
  const url = new URL(relayConnectUrl(raw));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

async function boundedError(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    await discardBody(response);
    return `relay returned ${response.status}`;
  }
  if (!response.body) return `relay returned ${response.status}`;
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > RESPONSE_LIMIT) {
        try {
          await reader.cancel();
        } catch {
          /* The bounded generic error below remains authoritative. */
        }
        return `relay returned ${response.status}`;
      }
      chunks.push(Buffer.from(next.value));
    }
    const body = Buffer.concat(chunks, total).toString("utf8");
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error !== "string") return `relay returned ${response.status}`;
    const message = parsed.error.trim().replace(/\s+/g, " ");
    return message &&
      message.length <= 200 &&
      !UNSAFE_TERMINAL_TEXT.test(message) &&
      !/\brr[a-z]_[A-Za-z0-9_-]{20,}\b|\bsha256:[A-Za-z0-9_-]{43}\b|\bBearer\s+/i.test(message)
      ? message
      : `relay returned ${response.status}`;
  } catch {
    return `relay returned ${response.status}`;
  } finally {
    reader.releaseLock();
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Status is authoritative; cancellation only releases an unused response stream early. */
  }
}

/** Host-authenticated provisioning uses HTTPS; routing credentials never appear in URLs or logs. */
export function createRelayDeviceProvisioner(options: RelayDeviceProvisionerOptions): RelayDeviceProvisioner {
  const origin = relayHttpOrigin(options.relayUrl);
  const routeId = safeId(options.routeId, "route id");
  if (!/^rrh_[A-Za-z0-9_-]{43}$/.test(options.hostCredential)) throw new Error("invalid relay host credential");
  const request = options.request ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000)
    throw new Error("invalid relay provisioning timeout");
  const endpoint = (deviceId: string) =>
    `${origin}/v1/routes/${encodeURIComponent(routeId)}/devices/${encodeURIComponent(safeId(deviceId, "device id"))}`;
  const signal = () =>
    typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : (undefined as AbortSignal | undefined);

  return {
    async putDevice(deviceId, credentialHash, expiresAt) {
      if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(credentialHash)) throw new Error("invalid relay credential hash");
      if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0))
        throw new Error("invalid relay device expiry");
      const requestSignal = signal();
      const response = await request(endpoint(deviceId), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${options.hostCredential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ credentialHash, ...(expiresAt === undefined ? {} : { expiresAt }) }),
        redirect: "error",
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
      if (!response.ok) throw new Error(`could not provision relay device: ${await boundedError(response)}`);
      await discardBody(response);
    },
    async revokeDevice(deviceId) {
      const requestSignal = signal();
      const response = await request(endpoint(deviceId), {
        method: "DELETE",
        headers: { authorization: `Bearer ${options.hostCredential}` },
        redirect: "error",
        ...(requestSignal ? { signal: requestSignal } : {}),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`could not revoke relay device: ${await boundedError(response)}`);
      }
      await discardBody(response);
    },
  };
}
