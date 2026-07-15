import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readRelayHostConfig, relayCredentialHash, type PersistedRelayHostConfig } from "@roamcode.ai/server";
import { parseArgs } from "../src/args.js";
import { readCloudAccountCredential, runCloudCommand, type CloudCommandOptions } from "../src/cloud.js";

const ACCOUNT_CREDENTIAL = `rrk_${"a".repeat(43)}`;
const HOST_CREDENTIAL = `rrh_${"h".repeat(43)}`;
const NEXT_HOST_CREDENTIAL = `rrh_${"n".repeat(43)}`;
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
});

describe("roamcode cloud", () => {
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

  test("rotate restores the previous local key when the control-plane update fails", async () => {
    const directory = temporaryDirectory();
    const io = outputs();
    const writes: PersistedRelayHostConfig[] = [];
    const fetch = vi.fn(async () =>
      response({ code: "RELAY_UNAVAILABLE", error: "try again" }, 503),
    ) as unknown as typeof globalThis.fetch;

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
    expect(writes[0]!.hostCredential).toBe(NEXT_HOST_CREDENTIAL);
    expect(writes[1]!.hostCredential).toBe(HOST_CREDENTIAL);
    expect(io.err.join("")).toContain("503 RELAY_UNAVAILABLE");
    expect(`${io.out.join("")} ${io.err.join("")}`).not.toContain(NEXT_HOST_CREDENTIAL);
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
});
