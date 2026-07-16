import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  readRelayHostConfig,
  relayAccountCredentialHash,
  relayAccountCredentialLookup,
  relayCredentialHash,
  writeRelayHostConfig,
  type PersistedRelayHostConfig,
} from "@roamcode.ai/server";
import { parseArgs } from "../src/args.js";
import {
  readCloudAccountCredential,
  readCloudRootCredential,
  runCloudCommand,
  type CloudCommandOptions,
} from "../src/cloud.js";

const ACCOUNT_CREDENTIAL = `rrk_${"a".repeat(43)}`;
const NEXT_ACCOUNT_CREDENTIAL = `rrk_${"n".repeat(43)}`;
const CHANGED_ACCOUNT_CREDENTIAL = `rrk_${"z".repeat(43)}`;
const ROOT_CREDENTIAL = `rrp_${"p".repeat(43)}`;
const ACCOUNT_ID = `rra_${"i".repeat(24)}`;
const HOST_CREDENTIAL = `rrh_${"h".repeat(43)}`;
const NEXT_HOST_CREDENTIAL = `rrh_${"n".repeat(43)}`;
const DEVICE_CREDENTIAL = `rrd_${"d".repeat(43)}`;
const ROUTE_ID = `rrt_${"r".repeat(24)}`;

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "roamcode-cloud-cli-"));
  directories.push(directory);
  return directory;
}

function tokenFile(directory: string, mode = 0o600): string {
  const path = join(directory, "account-token");
  writeFileSync(path, `${ACCOUNT_CREDENTIAL}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

function rootTokenFile(directory: string, mode = 0o600): string {
  const path = join(directory, "root-token");
  writeFileSync(path, `${ROOT_CREDENTIAL}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

function accountEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      id: ACCOUNT_ID,
      label: "Acme",
      status: "active",
      plan: "team",
      maxRoutes: 25,
      maxDevicesPerRoute: 64,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
    usage: { routes: 0, maxRoutes: 25 },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function outputs() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value) };
}

function persistedConfig(): PersistedRelayHostConfig {
  return {
    version: 1,
    relayUrl: "https://relay.example.test",
    routeId: ROUTE_ID,
    hostCredential: HOST_CREDENTIAL,
    appUrl: "https://app.example.test",
    hostLabel: "Test host",
  };
}

describe("cloud account credential files", () => {
  test("accepts only an owned, private regular file", () => {
    const directory = temporaryDirectory();
    const path = tokenFile(directory);
    expect(readCloudAccountCredential(path)).toBe(ACCOUNT_CREDENTIAL);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    chmodSync(path, 0o644);
    expect(() => readCloudAccountCredential(path)).toThrow(/chmod 600/);
  });

  test("refuses symlinks and malformed credentials", () => {
    const directory = temporaryDirectory();
    const target = tokenFile(directory);
    const link = join(directory, "account-token-link");
    symlinkSync(target, link);
    expect(() => readCloudAccountCredential(link)).toThrow(/regular file|symlink/);

    writeFileSync(target, "not-a-cloud-credential\n", { mode: 0o600 });
    expect(() => readCloudAccountCredential(target)).toThrow(/valid account credential/);
  });

  test("applies the same private-file boundary to relay root credentials", () => {
    const directory = temporaryDirectory();
    const path = rootTokenFile(directory);
    expect(readCloudRootCredential(path)).toBe(ROOT_CREDENTIAL);
    chmodSync(path, 0o640);
    expect(() => readCloudRootCredential(path)).toThrow(/chmod 600/);
  });
});

describe("roamcode cloud", () => {
  test("creates the first one-use remote enrollment directly from a configured host", async () => {
    const directory = temporaryDirectory();
    writeRelayHostConfig(directory, {
      relayUrl: "https://relay.example.test",
      routeId: ROUTE_ID,
      hostCredential: HOST_CREDENTIAL,
      appUrl: "https://app.example.test",
      hostLabel: "Build host",
    });
    const io = outputs();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith(`/v1/routes/${ROUTE_ID}/status`)) {
        expect(init?.method).toBe("GET");
        return response({ routeId: ROUTE_ID, hostOnline: true, activeDevices: 0 });
      }
      expect(String(url)).toMatch(new RegExp(`^https://relay\\.example\\.test/v1/routes/${ROUTE_ID}/devices/`));
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${HOST_CREDENTIAL}`);
      expect(init?.redirect).toBe("error");
      expect(String(init?.body)).not.toContain(DEVICE_CREDENTIAL);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        credentialHash: relayCredentialHash(DEVICE_CREDENTIAL),
      });
      return response({ device: { ok: true } });
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "pair"]),
      env: {},
      dataDir: directory,
      fetch,
      generateDeviceCredential: () => DEVICE_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code, io.err.join("")).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    const output = io.out.join("");
    const link = output.match(/https:\/\/app\.example\.test\/#relay-pair=[A-Za-z0-9_-]+/)?.[0];
    expect(link).toBeDefined();
    const encoded = new URL(link!).hash.slice("#relay-pair=".length);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: 1,
      label: "Build host",
      relayUrl: "https://relay.example.test",
      routeId: ROUTE_ID,
      deviceCredential: DEVICE_CREDENTIAL,
    });
    expect(payload.hostIdentityPublicKey).toEqual(expect.any(String));
    expect(payload.hostIdentityFingerprint).toEqual(expect.any(String));
    expect(output).toContain("Expires in 5 minutes");
    expect(output).toContain("provider credentials remain end-to-end encrypted");
    expect(output).not.toContain(HOST_CREDENTIAL);
  });

  test("does not spend a one-use enrollment while the configured cloud host is offline", async () => {
    const directory = temporaryDirectory();
    writeRelayHostConfig(directory, {
      relayUrl: "https://relay.example.test",
      routeId: ROUTE_ID,
      hostCredential: HOST_CREDENTIAL,
      appUrl: "https://app.example.test",
      hostLabel: "Build host",
    });
    const io = outputs();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://relay.example.test/v1/routes/${ROUTE_ID}/status`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${HOST_CREDENTIAL}`);
      return response({ routeId: ROUTE_ID, hostOnline: false, activeDevices: 0 });
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "pair"]),
      env: {},
      dataDir: directory,
      fetch,
      generateDeviceCredential: () => DEVICE_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toContain("cloud host is offline");
    expect(existsSync(join(directory, "devices.db"))).toBe(false);
  });

  test("removes local and broker bootstrap state when remote pairing preparation fails", async () => {
    const directory = temporaryDirectory();
    writeRelayHostConfig(directory, {
      relayUrl: "https://relay.example.test",
      routeId: ROUTE_ID,
      hostCredential: HOST_CREDENTIAL,
      appUrl: "https://app.example.test",
      hostLabel: "Build host",
    });
    const io = outputs();
    let deviceId = "";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith(`/v1/routes/${ROUTE_ID}/status`)) {
        return response({ routeId: ROUTE_ID, hostOnline: true, activeDevices: 0 });
      }
      deviceId = decodeURIComponent(requestUrl.pathname.split("/").at(-1) ?? "");
      if (init?.method === "DELETE") return response(undefined, 204);
      return response({ error: "temporarily unavailable" }, 503);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "pair"]),
      env: {},
      dataDir: directory,
      fetch,
      generateDeviceCredential: () => DEVICE_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(deviceId).not.toBe("");
    const { openDeviceStore } = await import("@roamcode.ai/server");
    const store = openDeviceStore({ dbPath: join(directory, "devices.db") });
    expect(store.pendingRelayPairing(deviceId), `device ${deviceId}; ${io.err.join("")}`).toBe(false);
    store.close();
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toContain("could not provision relay device: temporarily unavailable");
    expect(io.err.join("")).not.toContain(DEVICE_CREDENTIAL);
    expect(io.err.join("")).not.toContain(HOST_CREDENTIAL);
  });

  test("repairs a trusted app origin without replacing the existing cloud route", async () => {
    const directory = temporaryDirectory();
    const current = persistedConfig();
    delete current.appUrl;
    const writes: PersistedRelayHostConfig[] = [];
    const restart = vi.fn(() => ({ ok: true }));
    const io = outputs();

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "configure", "--app-url", "https://new-app.example.test"]),
      env: {},
      dataDir: directory,
      readConfig: () => current,
      writeConfig: (_dataDir, config) => {
        const persisted = { version: 1 as const, ...config };
        writes.push(persisted);
        return persisted;
      },
      readInstalledService: () => ({ manager: "systemd", label: "roamcode", path: "/test/service" }),
      restartInstalledService: restart,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(writes).toEqual([{ ...current, appUrl: "https://new-app.example.test" }]);
    expect(writes[0]!.routeId).toBe(ROUTE_ID);
    expect(writes[0]!.hostCredential).toBe(HOST_CREDENTIAL);
    expect(restart).toHaveBeenCalledOnce();
    expect(io.out.join("")).toContain("Trusted cloud app URL saved");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(HOST_CREDENTIAL);
  });

  test("keeps environment-managed cloud settings explicit during local configuration", async () => {
    const io = outputs();
    const code = await runCloudCommand({
      options: parseArgs(["cloud", "configure", "--app-url", "https://app.example.test"]),
      env: {
        ROAMCODE_RELAY_URL: "https://relay.example.test",
        ROAMCODE_RELAY_ROUTE_ID: ROUTE_ID,
        ROAMCODE_RELAY_HOST_CREDENTIAL: HOST_CREDENTIAL,
      },
      dataDir: "/test/data",
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("override managed cloud settings");
    expect(io.err.join("")).not.toContain(HOST_CREDENTIAL);
  });

  test("rejects an unsafe trusted app URL as usage before changing local state", async () => {
    const io = outputs();
    const writeConfig = vi.fn();
    const code = await runCloudCommand({
      options: parseArgs(["cloud", "configure", "--app-url", "http://public.example.test/path"]),
      env: {},
      dataDir: "/test/data",
      readConfig: persistedConfig,
      writeConfig,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("cloud app URL must be an HTTPS origin");
  });

  test("rejects a bidirectional-control host label before provisioning a route", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const fetch = vi.fn();
    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "connect",
        "--label",
        "Studio\u202Etxt.exe",
        "--account-token-file",
        tokenFile(directory),
      ]),
      env: {},
      dataDir: join(directory, "data"),
      fetch: fetch as unknown as typeof globalThis.fetch,
      readConfig: () => undefined,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(io.err.join("")).toContain("printable characters");
  });

  test("connect provisions a client-generated route and persists the raw host key only locally", async () => {
    const directory = temporaryDirectory();
    const accountTokenFile = tokenFile(directory);
    const io = outputs();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return response({ route: { id: ROUTE_ID, label: "Laptop" } }, 201);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "connect",
        "--url",
        "https://relay.example.test",
        "--app-url",
        "https://app.example.test",
        "--label",
        "Laptop",
        "--account-token-file",
        accountTokenFile,
      ]),
      env: {},
      dataDir: join(directory, "data"),
      fetch,
      generateRouteId: () => ROUTE_ID,
      generateHostCredential: () => HOST_CREDENTIAL,
      readInstalledService: () => undefined,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://relay.example.test/v1/account/routes" });
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(`Bearer ${ACCOUNT_CREDENTIAL}`);
    const requestBody = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>;
    expect(requestBody).toEqual({
      id: ROUTE_ID,
      label: "Laptop",
      credentialHash: relayCredentialHash(HOST_CREDENTIAL),
    });
    expect(String(requests[0]!.init?.body)).not.toContain(HOST_CREDENTIAL);
    expect(readRelayHostConfig(join(directory, "data"))).toMatchObject({
      relayUrl: "https://relay.example.test",
      routeId: ROUTE_ID,
      hostCredential: HOST_CREDENTIAL,
      appUrl: "https://app.example.test",
      hostLabel: "Laptop",
    });
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ACCOUNT_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(HOST_CREDENTIAL);
    expect(io.out.join("")).toContain("configured");
  });

  test("connect deletes the provisioned route if the local atomic write fails", async () => {
    const directory = temporaryDirectory();
    const methods: string[] = [];
    const io = outputs();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "DELETE" ? response(undefined, 204) : response({ route: { id: ROUTE_ID } }, 201);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "connect", "--account-token-file", tokenFile(directory)]),
      env: { ROAMCODE_CLOUD_URL: "https://relay.example.test" },
      dataDir: join(directory, "data"),
      fetch,
      generateRouteId: () => ROUTE_ID,
      generateHostCredential: () => HOST_CREDENTIAL,
      readConfig: () => undefined,
      writeConfig: () => {
        throw new Error("disk unavailable");
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(methods).toEqual(["POST", "DELETE"]);
    expect(io.err.join("")).toContain("rolled back");
    expect(io.err.join("")).not.toContain(HOST_CREDENTIAL);
    expect(io.err.join("")).not.toContain(ACCOUNT_CREDENTIAL);
  });

  test("connect does not delete a route when a late durability error follows a visible local commit", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    let stored: PersistedRelayHostConfig | undefined;
    const methods: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return response({ route: { id: ROUTE_ID } }, 201);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "connect", "--account-token-file", tokenFile(directory)]),
      env: { ROAMCODE_CLOUD_URL: "https://relay.example.test" },
      dataDir: join(directory, "data"),
      fetch,
      generateRouteId: () => ROUTE_ID,
      generateHostCredential: () => HOST_CREDENTIAL,
      readConfig: () => stored,
      writeConfig: (_dataDir, config) => {
        stored = { version: 1, ...config };
        throw new Error("directory fsync failed after rename");
      },
      readInstalledService: () => undefined,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(methods).toEqual(["POST"]);
    expect(stored).toMatchObject({ routeId: ROUTE_ID, hostCredential: HOST_CREDENTIAL });
    expect(io.out.join("")).toContain("configured");
  });

  test("retains a private recovery configuration when both provisioning and cleanup are ambiguous", async () => {
    const directory = temporaryDirectory();
    const dataDir = join(directory, "data");
    const io = outputs();
    const fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "connect", "--account-token-file", tokenFile(directory)]),
      env: { ROAMCODE_CLOUD_URL: "https://relay.example.test" },
      dataDir,
      fetch,
      generateRouteId: () => ROUTE_ID,
      generateHostCredential: () => HOST_CREDENTIAL,
      readInstalledService: () => undefined,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(readRelayHostConfig(dataDir)).toMatchObject({
      relayUrl: "https://relay.example.test",
      routeId: ROUTE_ID,
      hostCredential: HOST_CREDENTIAL,
      appUrl: "https://app.roamcode.ai",
    });
    expect(io.err.join("")).toContain("private recovery configuration was saved");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(HOST_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ACCOUNT_CREDENTIAL);
  });

  test("does not delete or persist a route after a definitive provisioning rejection", async () => {
    const directory = temporaryDirectory();
    const dataDir = join(directory, "data");
    const io = outputs();
    const fetch = vi.fn(async () =>
      response({ code: "RELAY_ROUTE_EXISTS", error: "relay route already exists" }, 409),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "connect", "--account-token-file", tokenFile(directory)]),
      env: { ROAMCODE_CLOUD_URL: "https://relay.example.test" },
      dataDir,
      fetch,
      generateRouteId: () => ROUTE_ID,
      generateHostCredential: () => HOST_CREDENTIAL,
      readInstalledService: () => undefined,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readRelayHostConfig(dataDir)).toBeUndefined();
    expect(io.err.join("")).toContain("409 RELAY_ROUTE_EXISTS");
  });

  test("status authenticates with the local host key but prints only safe state", async () => {
    const io = outputs();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${HOST_CREDENTIAL}`);
      return response({ routeId: ROUTE_ID, hostOnline: true, activeDevices: 2 });
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "status"]),
      env: {},
      dataDir: "/test/data",
      readConfig: persistedConfig,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Host relay: online");
    expect(io.out.join("")).toContain("Active devices: 2");
    expect(io.out.join("")).not.toContain(HOST_CREDENTIAL);
    expect(io.out.join("")).not.toContain(ROUTE_ID);
  });

  test("rotate compensates an ambiguous control-plane result before restoring the previous local key", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const writes: PersistedRelayHostConfig[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ code: "RELAY_UNAVAILABLE", error: "try again" }, 503))
      .mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ credentialHash: relayCredentialHash(HOST_CREDENTIAL) });
        return response(undefined, 204);
      }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "rotate", "--account-token-file", tokenFile(directory)]),
      env: {},
      dataDir: join(directory, "data"),
      readConfig: persistedConfig,
      writeConfig: (_dataDir, config) => {
        const persisted = { version: 1 as const, ...config };
        writes.push(persisted);
        return persisted;
      },
      generateHostCredential: () => NEXT_HOST_CREDENTIAL,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(writes).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(writes[0]!.hostCredential).toBe(NEXT_HOST_CREDENTIAL);
    expect(writes[1]!.hostCredential).toBe(HOST_CREDENTIAL);
    expect(io.err.join("")).toContain("503 RELAY_UNAVAILABLE");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(NEXT_HOST_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ACCOUNT_CREDENTIAL);
  });

  test("retains the new local host key when neither an ambiguous rotation nor its compensation can be confirmed", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const writes: PersistedRelayHostConfig[] = [];
    const fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "rotate", "--account-token-file", tokenFile(directory)]),
      env: {},
      dataDir: join(directory, "data"),
      readConfig: persistedConfig,
      writeConfig: (_dataDir, config) => {
        const persisted = { version: 1 as const, ...config };
        writes.push(persisted);
        return persisted;
      },
      generateHostCredential: () => NEXT_HOST_CREDENTIAL,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.hostCredential).toBe(NEXT_HOST_CREDENTIAL);
    expect(io.err.join("")).toContain("new credential remains saved locally");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(NEXT_HOST_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(HOST_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ACCOUNT_CREDENTIAL);
  });

  test("rotate commits the hash remotely and restarts an installed service", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const restart = vi.fn(() => ({ ok: true }));
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({ credentialHash: relayCredentialHash(NEXT_HOST_CREDENTIAL) });
      expect(String(init?.body)).not.toContain(NEXT_HOST_CREDENTIAL);
      return response(undefined, 204);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "rotate", "--account-token-file", tokenFile(directory)]),
      env: {},
      dataDir: join(directory, "data"),
      readConfig: persistedConfig,
      writeConfig: (_dataDir, config) => ({ version: 1, ...config }),
      readInstalledService: () => ({ manager: "systemd", label: "roamcode", path: "/test/service" }),
      restartInstalledService: restart,
      generateHostCredential: () => NEXT_HOST_CREDENTIAL,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(io.out.join("")).toContain("restarted");
  });

  test("rotate proceeds when a late durability error follows a verifiable local credential commit", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    let stored: PersistedRelayHostConfig | undefined = persistedConfig();
    const fetch = vi.fn(async () => response(undefined, 204)) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "rotate", "--account-token-file", tokenFile(directory)]),
      env: {},
      dataDir: join(directory, "data"),
      readConfig: () => stored,
      writeConfig: (_dataDir, config) => {
        stored = { version: 1, ...config };
        throw new Error("directory fsync failed after rename");
      },
      readInstalledService: () => undefined,
      generateHostCredential: () => NEXT_HOST_CREDENTIAL,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(stored?.hostCredential).toBe(NEXT_HOST_CREDENTIAL);
    expect(fetch).toHaveBeenCalledOnce();
    expect(io.out.join("")).toContain("rotated");
  });

  test("disconnect requires confirmation before reading credentials or mutating state", async () => {
    const io = outputs();
    const fetch = vi.fn();
    const removeConfig = vi.fn(() => true);
    const code = await runCloudCommand({
      options: parseArgs(["cloud", "disconnect"]),
      env: {},
      dataDir: "/test/data",
      readConfig: persistedConfig,
      removeConfig,
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--confirm");
    expect(fetch).not.toHaveBeenCalled();
    expect(removeConfig).not.toHaveBeenCalled();
  });

  test("disconnect treats an already-missing remote route as success and removes local state", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const removeConfig = vi.fn(() => true);
    const fetch = vi.fn(async () =>
      response({ code: "RELAY_ROUTE_NOT_FOUND" }, 404),
    ) as unknown as typeof globalThis.fetch;
    const options: CloudCommandOptions = {
      options: parseArgs(["cloud", "disconnect", "--confirm", "--account-token-file", tokenFile(directory)]),
      env: {},
      dataDir: join(directory, "data"),
      readConfig: persistedConfig,
      removeConfig,
      readInstalledService: () => undefined,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    };

    expect(await runCloudCommand(options)).toBe(0);
    expect(removeConfig).toHaveBeenCalledTimes(1);
    expect(io.out.join("")).toContain("disconnected");
  });

  test("disconnect succeeds when local removal is visible despite a late directory durability error", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    let stored: PersistedRelayHostConfig | undefined = persistedConfig();
    const fetch = vi.fn(async () => response(undefined, 204)) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs(["cloud", "disconnect", "--confirm", "--account-token-file", tokenFile(directory)]),
      env: {},
      dataDir: join(directory, "data"),
      readConfig: () => stored,
      removeConfig: () => {
        stored = undefined;
        throw new Error("directory fsync failed after unlink");
      },
      readInstalledService: () => undefined,
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(stored).toBeUndefined();
    expect(io.out.join("")).toContain("disconnected");
  });
});

describe("roamcode cloud account operations", () => {
  test("lists hosted accounts without printing capabilities", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ROOT_CREDENTIAL}`);
      return response({
        accounts: [accountEnvelope(), accountEnvelope({ id: `rra_${"j".repeat(24)}`, label: "Beta" })],
      });
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-list",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
      ]),
      env: {},
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("Label: Acme");
    expect(io.out.join("\n")).toContain("Label: Beta");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ROOT_CREDENTIAL);
  });

  test("creates the account with local credential material and atomically saves only the local capability", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "account-output");
    const io = outputs();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return response(accountEnvelope(), 201);
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-create",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--output",
        output,
        "--label",
        "Acme",
        "--plan",
        "team",
        "--max-routes",
        "25",
        "--max-devices-per-route",
        "64",
      ]),
      env: {},
      fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://relay.example.test/v1/accounts/client-hashed");
    expect(requests[0]!.init?.redirect).toBe("error");
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(`Bearer ${ROOT_CREDENTIAL}`);
    const body = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      label: "Acme",
      plan: "team",
      maxRoutes: 25,
      maxDevicesPerRoute: 64,
      credentialHash: relayAccountCredentialHash(NEXT_ACCOUNT_CREDENTIAL),
      credentialLookup: relayAccountCredentialLookup(NEXT_ACCOUNT_CREDENTIAL),
    });
    expect(String(requests[0]!.init?.body)).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
    expect(readFileSync(output, "utf8")).toBe(`${NEXT_ACCOUNT_CREDENTIAL}\n`);
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    expect(existsSync(`${output}.pending`)).toBe(false);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ROOT_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
    expect(io.out.join("")).toContain(ACCOUNT_ID);
  });

  test("removes staged credential material after an explicit API rejection", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "account-output");
    const io = outputs();
    const fetch = vi.fn(async () =>
      response({ code: "INVALID_RELAY_ACCOUNT", error: "invalid relay account" }, 400),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-create",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--output",
        output,
        "--label",
        "Acme",
      ]),
      env: {},
      fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.pending`)).toBe(false);
    expect(io.err.join("")).toContain("400 INVALID_RELAY_ACCOUNT");
    expect(io.err.join("")).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
  });

  test("rejects terminal-control account labels before staging a credential or calling the relay", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "account-output");
    const io = outputs();
    const fetch = vi.fn();

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-create",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--output",
        output,
        "--label",
        "Acme\u202Etxt.exe",
      ]),
      env: {},
      fetch: fetch as unknown as typeof globalThis.fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.pending`)).toBe(false);
    expect(io.err.join("")).toContain("printable characters");
  });

  test("retains the pending credential when a successful create response cannot be verified", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "account-output");
    const io = outputs();
    const fetch = vi.fn(async () =>
      response({ account: { ...accountEnvelope().account, id: "wrong" } }, 201),
    ) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-create",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--output",
        output,
        "--label",
        "Acme",
      ]),
      env: {},
      fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(readCloudAccountCredential(`${output}.pending`)).toBe(NEXT_ACCOUNT_CREDENTIAL);
    expect(io.err.join("")).toContain("could not be confirmed");
  });

  test("never prints a capability reflected by an untrusted relay error", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const fetch = vi.fn(async () =>
      response({ code: "RELAY_REJECTED", error: `reflected ${ROOT_CREDENTIAL}` }, 400),
    ) as unknown as typeof globalThis.fetch;

    expect(
      await runCloudCommand({
        options: parseArgs([
          "cloud",
          "account-list",
          "--url",
          "https://relay.example.test",
          "--root-token-file",
          rootTokenFile(directory),
        ]),
        env: {},
        fetch,
        stdout: io.stdout,
        stderr: io.stderr,
      }),
    ).toBe(1);
    expect(io.err.join("")).toContain("400 RELAY_REJECTED");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(ROOT_CREDENTIAL);
  });

  test("never prints a credential hash reflected by an untrusted relay error", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const reflectedHash = relayCredentialHash(HOST_CREDENTIAL);
    const fetch = vi.fn(async () =>
      response({ code: "RELAY_REJECTED", error: `reflected ${reflectedHash}` }, 400),
    ) as unknown as typeof globalThis.fetch;

    expect(
      await runCloudCommand({
        options: parseArgs([
          "cloud",
          "account-list",
          "--url",
          "https://relay.example.test",
          "--root-token-file",
          rootTokenFile(directory),
        ]),
        env: {},
        fetch,
        stdout: io.stdout,
        stderr: io.stderr,
      }),
    ).toBe(1);
    expect(io.err.join("")).toContain("400 RELAY_REJECTED");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(reflectedHash);
  });

  test("retains a private recovery file when remote creation is ambiguous", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "account-output");
    const io = outputs();
    const fetch = vi.fn(async () => {
      throw new Error("socket closed after send");
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-create",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--output",
        output,
        "--label",
        "Acme",
      ]),
      env: {},
      fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(`${output}.pending`, "utf8")).toBe(`${NEXT_ACCOUNT_CREDENTIAL}\n`);
    expect(lstatSync(`${output}.pending`).mode & 0o777).toBe(0o600);
    expect(io.err.join("")).toContain("could not be confirmed");
    expect(io.err.join("")).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
  });

  test("treats a relay 5xx as ambiguous and verifies the pending credential before committing it", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "account-output");
    const firstIo = outputs();
    const failedFetch = vi.fn(async () =>
      response({ code: "RELAY_UNAVAILABLE", error: "temporarily unavailable" }, 503),
    ) as unknown as typeof globalThis.fetch;

    expect(
      await runCloudCommand({
        options: parseArgs([
          "cloud",
          "account-create",
          "--url",
          "https://relay.example.test",
          "--root-token-file",
          rootTokenFile(directory),
          "--output",
          output,
          "--label",
          "Acme",
        ]),
        env: {},
        fetch: failedFetch,
        generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
        stdout: firstIo.stdout,
        stderr: firstIo.stderr,
      }),
    ).toBe(1);
    expect(existsSync(output)).toBe(false);
    expect(readCloudAccountCredential(`${output}.pending`)).toBe(NEXT_ACCOUNT_CREDENTIAL);
    expect(firstIo.err.join("")).toContain("could not be confirmed");

    const recoveryIo = outputs();
    const recoveryFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NEXT_ACCOUNT_CREDENTIAL}`);
      return response(accountEnvelope());
    }) as unknown as typeof globalThis.fetch;
    expect(
      await runCloudCommand({
        options: parseArgs([
          "cloud",
          "account-recover",
          "--url",
          "https://relay.example.test",
          "--output",
          output,
          "--account-id",
          ACCOUNT_ID,
        ]),
        env: {},
        fetch: recoveryFetch,
        stdout: recoveryIo.stdout,
        stderr: recoveryIo.stderr,
      }),
    ).toBe(0);
    expect(readCloudAccountCredential(output)).toBe(NEXT_ACCOUNT_CREDENTIAL);
    expect(existsSync(`${output}.pending`)).toBe(false);
    expect(recoveryIo.out.join("")).toContain("recovered");
    expect(`${recoveryIo.out.join("")} ${recoveryIo.err.join("")}`).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
  });

  test("bounds a chunked relay response before buffering it", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const fetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(70 * 1024));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-list",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
      ]),
      env: {},
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(io.err.join("")).toContain("oversized response");
  });

  test("rotates an account credential with revision protection and replaces the private file", async () => {
    const directory = temporaryDirectory();
    const output = tokenFile(directory);
    const io = outputs();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        expectedRevision: 1,
        credentialHash: relayAccountCredentialHash(NEXT_ACCOUNT_CREDENTIAL),
        credentialLookup: relayAccountCredentialLookup(NEXT_ACCOUNT_CREDENTIAL),
      });
      return response(accountEnvelope({ revision: 2 }));
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-rotate",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--account-id",
        ACCOUNT_ID,
        "--expected-revision",
        "1",
        "--output",
        output,
      ]),
      env: {},
      fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(readCloudAccountCredential(output)).toBe(NEXT_ACCOUNT_CREDENTIAL);
    expect(existsSync(`${output}.pending`)).toBe(false);
    expect(io.out.join("")).toContain("Revision: 2");
  });

  test("recovers an ambiguously rotated credential by replacing the verified previous file", async () => {
    const directory = temporaryDirectory();
    const output = tokenFile(directory);
    const rotationIo = outputs();
    const failedRotation = vi.fn(async () =>
      response({ code: "RELAY_UNAVAILABLE", error: "temporarily unavailable" }, 503),
    ) as unknown as typeof globalThis.fetch;

    expect(
      await runCloudCommand({
        options: parseArgs([
          "cloud",
          "account-rotate",
          "--url",
          "https://relay.example.test",
          "--root-token-file",
          rootTokenFile(directory),
          "--account-id",
          ACCOUNT_ID,
          "--expected-revision",
          "1",
          "--output",
          output,
        ]),
        env: {},
        fetch: failedRotation,
        generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
        stdout: rotationIo.stdout,
        stderr: rotationIo.stderr,
      }),
    ).toBe(1);
    expect(readCloudAccountCredential(output)).toBe(ACCOUNT_CREDENTIAL);
    expect(readCloudAccountCredential(`${output}.pending`)).toBe(NEXT_ACCOUNT_CREDENTIAL);

    const recoveryIo = outputs();
    const recoveryFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://relay.example.test/v1/account/recovery");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NEXT_ACCOUNT_CREDENTIAL}`);
      return response(accountEnvelope({ revision: 2, status: "suspended" }));
    }) as unknown as typeof globalThis.fetch;
    expect(
      await runCloudCommand({
        options: parseArgs([
          "cloud",
          "account-recover",
          "--url",
          "https://relay.example.test",
          "--output",
          output,
          "--account-id",
          ACCOUNT_ID,
        ]),
        env: {},
        fetch: recoveryFetch,
        stdout: recoveryIo.stdout,
        stderr: recoveryIo.stderr,
      }),
    ).toBe(0);
    expect(readCloudAccountCredential(output)).toBe(NEXT_ACCOUNT_CREDENTIAL);
    expect(existsSync(`${output}.pending`)).toBe(false);
    expect(recoveryIo.out.join("")).toContain("Revision: 2");
    expect(recoveryIo.out.join("")).toContain("Status: suspended");
    expect(`${recoveryIo.out.join("")} ${recoveryIo.err.join("")}`).not.toContain(ACCOUNT_CREDENTIAL);
    expect(`${recoveryIo.out.join("")} ${recoveryIo.err.join("")}`).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
  });

  test("does not overwrite a credential file changed while rotation is in flight", async () => {
    const directory = temporaryDirectory();
    const output = tokenFile(directory);
    const io = outputs();
    const fetch = vi.fn(async () => {
      writeFileSync(output, `${CHANGED_ACCOUNT_CREDENTIAL}\n`, { mode: 0o600 });
      chmodSync(output, 0o600);
      return response(accountEnvelope({ revision: 2 }));
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-rotate",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--account-id",
        ACCOUNT_ID,
        "--expected-revision",
        "1",
        "--output",
        output,
      ]),
      env: {},
      fetch,
      generateAccountCredential: () => NEXT_ACCOUNT_CREDENTIAL,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(1);
    expect(readCloudAccountCredential(output)).toBe(CHANGED_ACCOUNT_CREDENTIAL);
    expect(readCloudAccountCredential(`${output}.pending`)).toBe(NEXT_ACCOUNT_CREDENTIAL);
    expect(io.err.join("")).toContain("credential could not be committed");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(NEXT_ACCOUNT_CREDENTIAL);
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(CHANGED_ACCOUNT_CREDENTIAL);
  });

  test("requires confirmation for account deletion before reading root credentials or calling the relay", async () => {
    const io = outputs();
    const fetch = vi.fn();
    const code = await runCloudCommand({
      options: parseArgs(["cloud", "account-delete", "--account-id", ACCOUNT_ID, "--expected-revision", "1"]),
      env: {},
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(io.err.join("")).toContain("--confirm");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("updates every reviewed account field with revision protection", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://relay.example.test/v1/accounts/${ACCOUNT_ID}`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedRevision: 4,
        label: "Acme Platform",
        plan: "enterprise",
        status: "suspended",
        maxRoutes: 90,
        maxDevicesPerRoute: 300,
      });
      return response(
        accountEnvelope({
          label: "Acme Platform",
          plan: "enterprise",
          status: "suspended",
          maxRoutes: 90,
          maxDevicesPerRoute: 300,
          revision: 5,
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-update",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--account-id",
        ACCOUNT_ID,
        "--expected-revision",
        "4",
        "--label",
        "Acme Platform",
        "--plan",
        "enterprise",
        "--account-status",
        "suspended",
        "--max-routes",
        "90",
        "--max-devices-per-route",
        "300",
      ]),
      env: {},
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("Cloud account updated");
    expect(io.out.join("\n")).toContain("Revision: 5");
  });

  test("deletes an account only through the confirmed revision-guarded mutation", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://relay.example.test/v1/accounts/${ACCOUNT_ID}`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 7, status: "deleted" });
      return response(accountEnvelope({ status: "deleted", revision: 8 }));
    }) as unknown as typeof globalThis.fetch;

    const code = await runCloudCommand({
      options: parseArgs([
        "cloud",
        "account-delete",
        "--url",
        "https://relay.example.test",
        "--root-token-file",
        rootTokenFile(directory),
        "--account-id",
        ACCOUNT_ID,
        "--expected-revision",
        "7",
        "--confirm",
      ]),
      env: {},
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(io.out.join("\n")).toContain("Cloud account deleted");
    expect(io.out.join("\n")).toContain("Status: deleted");
  });
});
