import { join } from "node:path";
import {
  generateAccessToken,
  openDeviceStore,
  openPushStore,
  persistAccessToken,
  type PushStore,
} from "@roamcode.ai/server";
import { buildPairingUrl, pairingBaseUrl } from "./pair.js";

export interface ResetDeviceStore {
  mode: "sqlite" | "memory-fallback";
  revokeAll(): number;
  issuePairing(
    now: number,
    scopes: Array<"direct">,
  ): {
    secret: string;
    expiresAt: number;
    scopes: Array<"direct">;
  };
  close(): void;
}

export interface AccessResetDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  publicUrl?: string;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  isServerRunning?: () => Promise<boolean>;
  generateToken?: () => string;
  persistToken?: (dataDir: string, token: string) => void;
  openDevices?: (dbPath: string) => ResetDeviceStore;
  openPush?: (dbPath: string) => PushStore;
}

function portFrom(env: NodeJS.ProcessEnv): number {
  const value = Number(env.PORT);
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : 4280;
}

async function loopbackServerRunning(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${portFrom(env)}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Deliberately offline recovery. Refusing to touch SQLite while the service is live avoids racing its open
 * stores and guarantees the next boot reads one coherent host token/device inventory. No durable credential
 * is printed; the operator receives a fresh five-minute, one-use pairing link instead.
 */
export async function runAccessReset(deps: AccessResetDeps): Promise<number> {
  if (await (deps.isServerRunning ?? (() => loopbackServerRunning(deps.env)))()) {
    deps.stderr(
      "RoamCode is still running. Use Settings → Devices → Reset all access, or stop the service and rerun this command.\n",
    );
    return 1;
  }

  const devices = (deps.openDevices ?? ((path) => openDeviceStore({ dbPath: path }) as unknown as ResetDeviceStore))(
    join(deps.dataDir, "devices.db"),
  );
  if (devices.mode !== "sqlite") {
    devices.close();
    deps.stderr("Access reset requires durable SQLite support; reinstall RoamCode before retrying.\n");
    return 1;
  }

  let push: PushStore | undefined;
  try {
    push = (deps.openPush ?? ((path) => openPushStore({ dbPath: path })))(join(deps.dataDir, "push.db"));
    const revokedDevices = devices.revokeAll();
    for (const subscription of push.list()) push.remove(subscription.endpoint);
    const pairing = devices.issuePairing(Date.now(), ["direct"]);
    const token = (deps.generateToken ?? generateAccessToken)();
    (deps.persistToken ?? persistAccessToken)(deps.dataDir, token);

    const origin =
      deps.publicUrl ??
      deps.env.ROAMCODE_PUBLIC_URL ??
      deps.env.REMOTE_CODER_PUBLIC_URL ??
      `http://127.0.0.1:${portFrom(deps.env)}`;
    const url = buildPairingUrl(pairingBaseUrl(origin, deps.env), pairing.secret);
    deps.stdout(
      `Access reset complete. Revoked ${revokedDevices} paired device${revokedDevices === 1 ? "" : "s"}.\n` +
        "Start RoamCode, then open this one-use link within 5 minutes:\n" +
        `  ${url}\n`,
    );
    return 0;
  } catch (error) {
    deps.stderr(`Access reset failed: ${(error as Error).message}\n`);
    return 1;
  } finally {
    push?.close();
    devices.close();
  }
}
