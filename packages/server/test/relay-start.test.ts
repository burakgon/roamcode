import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { isRelayDirectExecution, startBlindRelay, type StartedBlindRelay } from "../src/relay-start.js";
import { generateRelayCredential, relayCredentialHash } from "../src/relay-store.js";

const directories: string[] = [];
const relays: StartedBlindRelay[] = [];

afterEach(async () => {
  while (relays.length > 0) await relays.pop()!.app.close();
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "roamcode-relay-start-"));
  directories.push(directory);
  return directory;
}

describe("blind relay executable", () => {
  test("fails closed without the root provisioning capability", async () => {
    await expect(
      startBlindRelay({
        ROAMCODE_RELAY_DATA_DIR: await temporaryDirectory(),
        ROAMCODE_RELAY_PORT: "0",
      }),
    ).rejects.toThrow("ROAMCODE_RELAY_ROOT_TOKEN or ROAMCODE_RELAY_ROOT_TOKEN_FILE is required");
  });

  test("starts against an isolated durable store and never puts secrets in its URL", async () => {
    const rootToken = generateRelayCredential("rrp");
    const relay = await startBlindRelay({
      ROAMCODE_RELAY_ROOT_TOKEN: rootToken,
      ROAMCODE_RELAY_DATA_DIR: await temporaryDirectory(),
      ROAMCODE_RELAY_BIND: "127.0.0.1",
      ROAMCODE_RELAY_PORT: "0",
    });
    relays.push(relay);

    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(relay.url).not.toContain(rootToken);
    const health = await relay.app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toEqual({ status: "ok", protocolVersion: 1 });

    const created = await relay.app.inject({
      method: "POST",
      url: "/v1/routes",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { label: "Isolated relay" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(rootToken);
  });

  test("reads the provisioning capability from a mounted secret file without accepting ambiguous sources", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "relay-root-token");
    const rootToken = generateRelayCredential("rrp");
    await writeFile(secretPath, `${rootToken}\n`, { mode: 0o600 });
    const relay = await startBlindRelay({
      ROAMCODE_RELAY_ROOT_TOKEN_FILE: secretPath,
      ROAMCODE_RELAY_DATA_DIR: directory,
      ROAMCODE_RELAY_BIND: "127.0.0.1",
      ROAMCODE_RELAY_PORT: "0",
    });
    relays.push(relay);
    const inventory = await relay.app.inject({
      method: "GET",
      url: "/v1/routes",
      headers: { authorization: `Bearer ${rootToken}` },
    });
    expect(inventory.statusCode).toBe(200);
    await expect(
      startBlindRelay({
        ROAMCODE_RELAY_ROOT_TOKEN: rootToken,
        ROAMCODE_RELAY_ROOT_TOKEN_FILE: secretPath,
        ROAMCODE_RELAY_DATA_DIR: directory,
        ROAMCODE_RELAY_PORT: "0",
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  test("persists hosted accounts and their owned routes across relay restarts", async () => {
    const directory = await temporaryDirectory();
    const rootToken = generateRelayCredential("rrp");
    const env = {
      ROAMCODE_RELAY_ROOT_TOKEN: rootToken,
      ROAMCODE_RELAY_ACCOUNTS_ENABLED: "1",
      ROAMCODE_RELAY_DATA_DIR: directory,
      ROAMCODE_RELAY_BIND: "127.0.0.1",
      ROAMCODE_RELAY_PORT: "0",
    };
    const first = await startBlindRelay(env);
    relays.push(first);
    const createdAccount = await first.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { authorization: `Bearer ${rootToken}` },
      payload: { label: "Durable cloud account" },
    });
    expect(createdAccount.statusCode).toBe(201);
    const accountCredential = createdAccount.json().accountCredential as string;
    const hostCredential = generateRelayCredential("rrh");
    const createdRoute = await first.app.inject({
      method: "POST",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${accountCredential}` },
      payload: {
        id: "rrt_durablehost000000000001",
        label: "Durable host",
        credentialHash: relayCredentialHash(hostCredential),
      },
    });
    expect(createdRoute.statusCode).toBe(201);
    const routeId = createdRoute.json().route.id as string;
    await first.app.close();
    relays.pop();

    const restarted = await startBlindRelay(env);
    relays.push(restarted);
    const account = await restarted.app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { authorization: `Bearer ${accountCredential}` },
    });
    expect(account.statusCode).toBe(200);
    expect(account.json()).toMatchObject({ usage: { routes: 1 } });
    const routes = await restarted.app.inject({
      method: "GET",
      url: "/v1/account/routes",
      headers: { authorization: `Bearer ${accountCredential}` },
    });
    expect(routes.json()).toEqual({ routes: [expect.objectContaining({ id: routeId, label: "Durable host" })] });
    expect(restarted.store.authenticateHost(routeId, hostCredential)).toBe(true);
  });

  test("requires an explicit browser-origin policy in production", async () => {
    await expect(
      startBlindRelay({
        NODE_ENV: "production",
        ROAMCODE_RELAY_ROOT_TOKEN: generateRelayCredential("rrp"),
        ROAMCODE_RELAY_DATA_DIR: await temporaryDirectory(),
        ROAMCODE_RELAY_PORT: "0",
      }),
    ).rejects.toThrow("ROAMCODE_RELAY_ALLOWED_ORIGINS is required in production");
  });

  test("validates operational limits before accepting traffic", async () => {
    await expect(
      startBlindRelay({
        ROAMCODE_RELAY_ROOT_TOKEN: generateRelayCredential("rrp"),
        ROAMCODE_RELAY_DATA_DIR: await temporaryDirectory(),
        ROAMCODE_RELAY_PORT: "0",
        ROAMCODE_RELAY_MAX_CONNECTIONS_PER_ROUTE: "0",
      }),
    ).rejects.toThrow("invalid relay route connection limit");
  });

  test("detects direct execution by canonical path", () => {
    expect(isRelayDirectExecution(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
    expect(isRelayDirectExecution(import.meta.url, fileURLToPath(import.meta.url), true)).toBe(false);
    expect(isRelayDirectExecution(import.meta.url, undefined)).toBe(false);
    expect(isRelayDirectExecution(import.meta.url, "/path/that/does/not/exist")).toBe(false);
  });
});
