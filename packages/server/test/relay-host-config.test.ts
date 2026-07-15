import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { relayConnectUrl } from "../src/relay-host.js";
import {
  readRelayHostConfig,
  relayHostConfigPath,
  removeRelayHostConfig,
  resolveRelayHostConfig,
  writeRelayHostConfig,
} from "../src/relay-host-config.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "roamcode-relay-config-"));
  directories.push(value);
  return value;
}

describe("relay host runtime configuration", () => {
  test("is opt-in and rejects partial configuration before creating identity state", async () => {
    const directory = await dataDir();
    expect(resolveRelayHostConfig({}, directory)).toBeUndefined();
    expect(() => resolveRelayHostConfig({ ROAMCODE_RELAY_URL: "https://relay.example" }, directory)).toThrow(
      "configuration is incomplete",
    );
    expect(existsSync(join(directory, "relay-identity.json"))).toBe(false);
  });

  test("loads one stable identity for a complete TLS relay configuration", async () => {
    const directory = await dataDir();
    const env = {
      ROAMCODE_RELAY_URL: "https://relay.example",
      ROAMCODE_RELAY_ROUTE_ID: "route-studio",
      ROAMCODE_RELAY_HOST_CREDENTIAL: `rrh_${"h".repeat(43)}`,
      ROAMCODE_RELAY_APP_URL: "https://app.roamcode.example",
      ROAMCODE_HOST_NAME: "Studio Mac",
    };
    const first = resolveRelayHostConfig(env, directory)!;
    const second = resolveRelayHostConfig(env, directory)!;
    expect(first).toMatchObject({
      relayUrl: "https://relay.example",
      routeId: "route-studio",
      hostCredential: env.ROAMCODE_RELAY_HOST_CREDENTIAL,
      appUrl: "https://app.roamcode.example",
      hostLabel: "Studio Mac",
    });
    expect(second.hostIdentity.fingerprint).toBe(first.hostIdentity.fingerprint);
    expect(existsSync(join(directory, "relay-identity.json"))).toBe(true);
  });

  test("requires a secure origin for the remote pairing PWA", async () => {
    const directory = await dataDir();
    expect(() =>
      resolveRelayHostConfig(
        {
          ROAMCODE_RELAY_URL: "https://relay.example",
          ROAMCODE_RELAY_ROUTE_ID: "route-studio",
          ROAMCODE_RELAY_HOST_CREDENTIAL: `rrh_${"h".repeat(43)}`,
          ROAMCODE_RELAY_APP_URL: "http://app.example",
        },
        directory,
      ),
    ).toThrow("must use HTTPS");
  });

  test("persists cloud route configuration in a mode-0600 file and loads it without service env changes", async () => {
    const directory = await dataDir();
    const hostCredential = `rrh_${"h".repeat(43)}`;
    const persisted = writeRelayHostConfig(directory, {
      relayUrl: "https://relay.example",
      routeId: "route-cloud",
      hostCredential,
      appUrl: "https://app.example",
      hostLabel: "Cloud workstation",
    });
    expect(readRelayHostConfig(directory)).toEqual(persisted);
    expect(statSync(relayHostConfigPath(directory)).mode & 0o777).toBe(0o600);
    expect(resolveRelayHostConfig({}, directory)).toMatchObject({
      relayUrl: "https://relay.example",
      routeId: "route-cloud",
      hostCredential,
      appUrl: "https://app.example",
      hostLabel: "Cloud workstation",
    });
    expect(removeRelayHostConfig(directory)).toBe(true);
    expect(removeRelayHostConfig(directory)).toBe(false);
  });

  test("environment configuration overrides the persisted cloud route and supports the documented relay label", async () => {
    const directory = await dataDir();
    writeRelayHostConfig(directory, {
      relayUrl: "https://old-relay.example",
      routeId: "old-route",
      hostCredential: `rrh_${"o".repeat(43)}`,
      hostLabel: "Old host",
    });
    expect(
      resolveRelayHostConfig(
        {
          ROAMCODE_RELAY_URL: "https://new-relay.example",
          ROAMCODE_RELAY_ROUTE_ID: "new-route",
          ROAMCODE_RELAY_HOST_CREDENTIAL: `rrh_${"n".repeat(43)}`,
          ROAMCODE_RELAY_HOST_LABEL: "New host",
        },
        directory,
      ),
    ).toMatchObject({ relayUrl: "https://new-relay.example", routeId: "new-route", hostLabel: "New host" });
  });

  test("refuses a symlink in place of the persisted secret-bearing config", async () => {
    const directory = await dataDir();
    const target = join(directory, "target.json");
    await writeFile(target, "{}\n");
    await symlink(target, relayHostConfigPath(directory));
    expect(() => readRelayHostConfig(directory)).toThrow("regular file");
    expect(() =>
      writeRelayHostConfig(directory, {
        relayUrl: "https://relay.example",
        routeId: "route-cloud",
        hostCredential: `rrh_${"h".repeat(43)}`,
        hostLabel: "Host",
      }),
    ).toThrow("regular file");
  });

  test("normalizes supported endpoints and requires TLS away from loopback", () => {
    expect(relayConnectUrl("https://relay.example")).toBe("wss://relay.example/v1/connect");
    expect(relayConnectUrl("wss://relay.example/v1/connect")).toBe("wss://relay.example/v1/connect");
    expect(relayConnectUrl("http://127.0.0.1:4281")).toBe("ws://127.0.0.1:4281/v1/connect");
    expect(() => relayConnectUrl("ws://relay.example/v1/connect")).toThrow("must use TLS");
    expect(() => relayConnectUrl("https://user:secret@relay.example")).toThrow("cannot contain credentials");
    expect(() => relayConnectUrl("https://relay.example/admin")).toThrow("path must be /v1/connect");
  });
});
