import { chmodSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2,
} from "../src/cloud-contract.js";
import {
  CLOUD_HOST_CONFIG_FILE,
  CloudHostConfigV1Schema,
  CloudHostConfigV2Schema,
  cloudHostConfigPath,
  readCloudHostConfig,
  removeCloudHostConfig,
  replaceCloudHostAuthorizationKeyset,
  resolveCloudHostConfig,
  writeCloudHostConfig,
  type CloudHostConfigV1,
} from "../src/cloud-host-config.js";
import {
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
  CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2,
} from "../src/cloud-keyset.js";
import {
  cloudAuthorizationKeyset,
  cloudAuthorizationKeysetKey,
  cloudAuthorizationKeysetKeyV2,
  cloudAuthorizationKeysetV2,
  cloudSigningFixture,
} from "./helpers/cloud-authorization.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "roamcode-cloud-host-config-"));
  directories.push(directory);
  return directory;
}

function fixture(overrides: Record<string, unknown> = {}): CloudHostConfigV1 {
  const key = cloudSigningFixture("bootstrap-key");
  return CloudHostConfigV1Schema.parse({
    v: 1,
    kind: "roamcode-cloud-host-config",
    organizationId: "11111111-1111-4111-8111-111111111111",
    hostId: "22222222-2222-4222-8222-222222222222",
    controlPlaneOrigin: "https://control.roamcode.ai/",
    hostCredential: `rch_${"a".repeat(64)}`,
    authorization: {
      algorithm: "Ed25519",
      signatureDomain: CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN,
      keysetSignatureDomain: CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN,
      keyset: cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(key, { status: "current" })]),
    },
    heartbeatIntervalSeconds: 30,
    authorizationRefreshIntervalSeconds: 60,
    ...overrides,
  });
}

describe("cloud host configuration", () => {
  test("writes and reads the provisioned host capability atomically as a separate mode-0600 file", async () => {
    const directory = await dataDir();
    const path = cloudHostConfigPath(directory);
    const expected = fixture();

    expect(writeCloudHostConfig(path, expected)).toEqual(expected);
    expect(readCloudHostConfig(path)).toEqual({ ...expected, controlPlaneOrigin: "https://control.roamcode.ai" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(path).toBe(join(directory, CLOUD_HOST_CONFIG_FILE));
  });

  test("removes only the verified managed host file and is idempotent", async () => {
    const directory = await dataDir();
    const path = cloudHostConfigPath(directory);
    writeCloudHostConfig(path, fixture());
    expect(removeCloudHostConfig(path)).toBe(true);
    expect(readCloudHostConfig(path)).toBeUndefined();
    expect(removeCloudHostConfig(path)).toBe(false);
  });

  test("persists a verified key rotation without changing credential fields or relay-host.json", async () => {
    const directory = await dataDir();
    const path = cloudHostConfigPath(directory);
    const relayPath = join(directory, "relay-host.json");
    await writeFile(relayPath, '{"ownedBy":"relay"}\n', { mode: 0o600 });
    const originalRelay = await readFile(relayPath, "utf8");
    const original = writeCloudHostConfig(path, fixture());
    const nextKey = cloudSigningFixture("rotated-key");
    const nextKeyset = cloudAuthorizationKeyset(
      [cloudAuthorizationKeysetKey(nextKey, { status: "current", notBefore: 2_000 })],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );

    const replaced = replaceCloudHostAuthorizationKeyset(path, original, nextKeyset);
    expect(replaced).toEqual({
      ...original,
      authorization: { ...original.authorization, keyset: nextKeyset },
    });
    expect(readCloudHostConfig(path)).toEqual(replaced);
    expect(await readFile(relayPath, "utf8")).toBe(originalRelay);
  });

  test("refuses to overwrite a concurrently replaced host capability during key rotation", async () => {
    const directory = await dataDir();
    const path = cloudHostConfigPath(directory);
    const original = writeCloudHostConfig(path, fixture());
    const replacedCredential = `rch_${"b".repeat(64)}`;
    writeCloudHostConfig(path, { ...original, hostCredential: replacedCredential });
    const nextKey = cloudSigningFixture("rotated-key");
    const nextKeyset = cloudAuthorizationKeyset(
      [cloudAuthorizationKeysetKey(nextKey, { status: "current", notBefore: 2_000 })],
      { issuedAt: 2_000, expiresAt: 12_000 },
    );

    expect(() => replaceCloudHostAuthorizationKeyset(path, original, nextKeyset)).toThrow(
      "cloud host configuration changed",
    );
    expect(readCloudHostConfig(path)?.hostCredential).toBe(replacedCredential);
  });

  test("keeps self-host startup unchanged when no host config exists and fails an explicit missing path", async () => {
    const directory = await dataDir();
    expect(resolveCloudHostConfig({}, directory)).toBeUndefined();
    expect(() =>
      resolveCloudHostConfig({ ROAMCODE_CLOUD_HOST_CONFIG_FILE: join(directory, "missing.json") }, directory),
    ).toThrow("configured cloud host configuration file does not exist");

    const customPath = join(directory, "host-capability.json");
    const config = writeCloudHostConfig(customPath, fixture());
    expect(resolveCloudHostConfig({ ROAMCODE_CLOUD_HOST_CONFIG_FILE: customPath }, directory)).toEqual({
      path: customPath,
      config,
    });
  });

  test("rejects weak credentials, unsafe origins, missing signature domains, and extra fields", () => {
    const config = fixture();
    expect(CloudHostConfigV1Schema.safeParse({ ...config, hostCredential: "rch_short" }).success).toBe(false);
    expect(CloudHostConfigV1Schema.safeParse({ ...config, controlPlaneOrigin: "http://example.com" }).success).toBe(
      false,
    );
    expect(
      CloudHostConfigV1Schema.safeParse({
        ...config,
        authorization: {
          algorithm: config.authorization.algorithm,
          signatureDomain: config.authorization.signatureDomain,
          keyset: config.authorization.keyset,
        },
      }).success,
    ).toBe(false);
    expect(CloudHostConfigV1Schema.safeParse({ ...config, unexpected: true }).success).toBe(false);
  });

  test("strictly decodes a V2 profile and rejects hybrid version, algorithm, or keyset downgrades", async () => {
    const key = cloudSigningFixture("bootstrap-key-v2");
    const config = CloudHostConfigV2Schema.parse({
      v: 2,
      kind: "roamcode-cloud-host-config",
      organizationId: "11111111-1111-4111-8111-111111111111",
      hostId: "22222222-2222-4222-8222-222222222222",
      controlPlaneOrigin: "https://control.roamcode.ai",
      hostCredential: `rch_${"a".repeat(64)}`,
      authorization: {
        algorithm: "Ed25519-SHA256",
        signatureDomain: CLOUD_AUTHORIZATION_SIGNATURE_DOMAIN_V2,
        keysetSignatureDomain: CLOUD_AUTHORIZATION_KEYSET_SIGNATURE_DOMAIN_V2,
        keyset: cloudAuthorizationKeysetV2([cloudAuthorizationKeysetKeyV2(key, { status: "current" })]),
      },
      heartbeatIntervalSeconds: 30,
      authorizationRefreshIntervalSeconds: 60,
    });
    expect(CloudHostConfigV2Schema.parse(config)).toEqual(config);
    expect(
      CloudHostConfigV2Schema.safeParse({
        ...config,
        authorization: { ...config.authorization, algorithm: "Ed25519" },
      }).success,
    ).toBe(false);
    const directory = await dataDir();
    const path = cloudHostConfigPath(directory);
    writeCloudHostConfig(path, config);
    expect(() =>
      replaceCloudHostAuthorizationKeyset(
        path,
        config,
        cloudAuthorizationKeyset([cloudAuthorizationKeysetKey(key, { status: "current" })]),
      ),
    ).toThrow("contract does not match");
  });

  test.runIf(process.platform !== "win32")("rejects symlink, permissive, and corrupt config files", async () => {
    const directory = await dataDir();
    const path = cloudHostConfigPath(directory);
    writeCloudHostConfig(path, fixture());
    chmodSync(path, 0o644);
    expect(() => readCloudHostConfig(path)).toThrow("mode 0600");

    chmodSync(path, 0o600);
    await writeFile(path, "not-json\n", { mode: 0o600 });
    expect(() => readCloudHostConfig(path)).toThrow("corrupt");

    await rm(path);
    const target = join(directory, "target.json");
    writeCloudHostConfig(target, fixture());
    await symlink(target, path);
    expect(() => readCloudHostConfig(path)).toThrow("regular file");
  });
});
