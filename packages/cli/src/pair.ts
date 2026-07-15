import { join } from "node:path";
import qrcode from "qrcode-terminal";
import type { DeviceStore } from "@roamcode.ai/server";

export interface PairCommandDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  publicUrl?: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  openStore?: (dbPath: string) => DeviceStore;
}

function configuredPort(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.PORT);
  return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : 4280;
}

/** Validate and canonicalize the origin before a capability is embedded in it. */
export function pairingBaseUrl(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const candidate =
    explicit ?? env.ROAMCODE_PUBLIC_URL ?? env.REMOTE_CODER_PUBLIC_URL ?? `http://127.0.0.1:${configuredPort(env)}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("pairing URL must be a valid http(s) origin");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("pairing URL must be an http(s) origin without embedded credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("pairing URL must be an origin only (no path, query, or fragment)");
  }
  return url.origin;
}

export function buildPairingUrl(baseUrl: string, secret: string): string {
  const url = new URL("/", baseUrl);
  // A URL fragment is never sent in the HTTP request or written by a reverse proxy/access log. The PWA
  // consumes it locally, strips it immediately, then POSTs the capability in the claim body over HTTPS.
  url.hash = new URLSearchParams({ pair: secret }).toString();
  return url.toString();
}

function renderQr(value: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(value, { small: true }, (qr) => resolve(qr));
  });
}

/**
 * Create a durable, short-lived pairing session directly in the service's SQLite store. This avoids
 * sending the host master token to whatever happens to own the loopback port; the running server sees
 * the WAL-backed row immediately, and a ticket issued while it is restarting remains claimable.
 */
export async function runPairCommand(deps: PairCommandDeps): Promise<number> {
  let baseUrl: string;
  try {
    baseUrl = pairingBaseUrl(deps.publicUrl, deps.env);
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n`);
    return 2;
  }

  const dbPath = join(deps.dataDir, "devices.db");
  const store = deps.openStore
    ? deps.openStore(dbPath)
    : (await import("@roamcode.ai/server")).openDeviceStore({ dbPath });
  try {
    if (store.mode !== "sqlite") {
      deps.stderr("device pairing requires a working better-sqlite3 install; repair it and try again\n");
      return 1;
    }
    const pairing = store.issuePairing();
    const link = buildPairingUrl(baseUrl, pairing.secret);
    const qr = await renderQr(link);
    const hostname = new URL(baseUrl).hostname;
    const loopbackNotice = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname)
      ? "\nThis loopback link opens only on this machine. For a phone, rerun with --url <your stable HTTPS origin>.\n"
      : "";
    deps.stdout(
      `Pair a device with RoamCode\n\n${qr}\nOpen this one-time link on the new device:\n${link}\n\n` +
        `Expires in 5 minutes and can be used once. The host access token is not included.\n${loopbackNotice}`,
    );
    return 0;
  } catch {
    deps.stderr("could not create a device pairing link\n");
    return 1;
  } finally {
    store.close();
  }
}
