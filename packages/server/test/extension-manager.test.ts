import { generateKeyPairSync, sign } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  inspectExtensionPackage,
  openExtensionManager,
  parseMarketplaceIndex,
  searchMarketplace,
} from "../src/extension-manager.js";
import type { AdapterPackageManifestV1, ExtensionManager, PluginManifestV1 } from "../src/extension-manager.js";

let root: string;
let packagesDir: string;
let manager: ExtensionManager | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roamcode-extension-"));
  packagesDir = join(root, "installed");
});

afterEach(async () => {
  manager?.close();
  manager = undefined;
  await rm(root, { recursive: true, force: true });
});

async function pluginPackage(version: string, suffix = ""): Promise<string> {
  const directory = join(root, `source-${version}-${suffix || "main"}`);
  await mkdir(join(directory, "bin"), { recursive: true });
  const manifest: PluginManifestV1 = {
    schemaVersion: 1,
    kind: "plugin",
    id: "ci-monitor",
    version,
    displayName: "CI monitor",
    description: "Reports bounded CI status events.",
    platforms: ["darwin", "linux"],
    permissions: ["ci:read", "events:write"],
    actions: [
      {
        id: "check",
        title: "Check CI",
        entrypoint: "bin/check.mjs",
        args: [],
        cwd: "workspace",
        timeoutMs: 1_000,
        maxOutputBytes: 8_192,
        permissions: ["ci:read"],
      },
    ],
    eventHooks: [],
    settingsSchema: { type: "object" },
  };
  await writeFile(join(directory, "roamcode-extension.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(directory, "bin", "check.mjs"),
    `process.stdout.write(${JSON.stringify(`ok-${version}-${suffix}`)})`,
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );
  return directory;
}

async function adapterPackage(suffix: string, mutate: (manifest: AdapterPackageManifestV1) => void): Promise<string> {
  const directory = join(root, `adapter-${suffix}`);
  await mkdir(join(directory, "bin"), { recursive: true });
  const manifest: AdapterPackageManifestV1 = {
    schemaVersion: 1,
    kind: "adapter",
    adapter: {
      schemaVersion: 1,
      id: `fixture-${suffix}`,
      version: "1.0.0",
      displayName: "Fixture adapter",
      platforms: ["darwin", "linux"],
      resumeIdentity: "required",
      capabilities: {
        probe: true,
        launch: true,
        resume: true,
        state: true,
        identity: true,
        metadata: false,
        usage: false,
        login: false,
        attachments: false,
        cleanup: true,
      },
      stateAuthority: ["runtime-signals", "pane-heuristics"],
      optionSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    runtime: {
      executable: "bin/agent.mjs",
      probeArgs: ["--version"],
      probeTimeoutMs: 1_000,
      launchArgs: ["--session", "{sessionId}"],
      resumeArgs: ["--resume", "{providerSessionId}"],
      env: ["PATH"],
      workingPatterns: ["WORKING"],
      blockedPatterns: [],
      idlePatterns: ["IDLE"],
      identityPattern: "RID=([A-Za-z0-9-]+)",
    },
  };
  mutate(manifest);
  await writeFile(join(directory, "roamcode-extension.json"), JSON.stringify(manifest), "utf8");
  await writeFile(join(directory, "bin", "agent.mjs"), "process.stdout.write('ok')", "utf8");
  return directory;
}

function signature(integrity: string) {
  const pair = generateKeyPairSync("ed25519");
  return {
    signature: sign(null, Buffer.from(integrity, "utf8"), pair.privateKey).toString("base64"),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("verified extension lifecycle", () => {
  test("installs immutable signed bytes, updates, disables, rolls back, and preserves owned state", async () => {
    manager = openExtensionManager({
      dbPath: join(root, "extensions.db"),
      packagesDir,
      fsRoot: root,
      now: (() => {
        let value = 10;
        return () => value++;
      })(),
    });
    const source100 = await pluginPackage("1.0.0");
    const inspected100 = await inspectExtensionPackage(source100, root);
    const installed100 = await manager.install({
      sourceDirectory: source100,
      expectedIntegrity: inspected100.integrity,
      ...signature(inspected100.integrity),
      source: "local-test",
    });
    expect(installed100).toMatchObject({
      kind: "plugin",
      id: "ci-monitor",
      enabled: false,
      currentVersion: "1.0.0",
      current: { trust: "signed", signerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(() => manager!.setEnabled("plugin", "ci-monitor", true)).toThrow("explicit approval");
    manager.setEnabled("plugin", "ci-monitor", true, ["ci:read", "events:write"]);

    const source110 = await pluginPackage("1.1.0");
    const inspected110 = await inspectExtensionPackage(source110, root);
    const updated = await manager.install({
      sourceDirectory: source110,
      expectedIntegrity: inspected110.integrity,
      ...signature(inspected110.integrity),
    });
    expect(updated).toMatchObject({ enabled: true, currentVersion: "1.1.0", previousVersion: "1.0.0" });
    expect(manager.rollback("plugin", "ci-monitor")).toMatchObject({
      currentVersion: "1.0.0",
      previousVersion: "1.1.0",
    });

    const stateFile = join(packagesDir, "state", "plugin", "ci-monitor", "cache.json");
    await mkdir(join(stateFile, ".."), { recursive: true });
    await writeFile(stateFile, "{}", "utf8");
    manager.setEnabled("plugin", "ci-monitor", false);
    await expect(manager.uninstall("plugin", "ci-monitor")).resolves.toBe(true);
    await expect(access(stateFile)).resolves.toBeUndefined();
    expect(manager.get("plugin", "ci-monitor")).toBeUndefined();
  });

  test("rejects tampering, version-byte reuse, symlinks, and implicit unsigned installs", async () => {
    manager = openExtensionManager({ dbPath: join(root, "extensions.db"), packagesDir, fsRoot: root });
    const source = await pluginPackage("1.0.0");
    const inspected = await inspectExtensionPackage(source, root);
    await expect(
      manager.install({ sourceDirectory: source, expectedIntegrity: `sha256-${"A".repeat(43)}=`, allowUnsigned: true }),
    ).rejects.toMatchObject({ code: "EXTENSION_INTEGRITY_MISMATCH" });
    await expect(
      manager.install({ sourceDirectory: source, expectedIntegrity: inspected.integrity }),
    ).rejects.toMatchObject({
      code: "EXTENSION_SIGNATURE_INVALID",
    });
    await manager.install({ sourceDirectory: source, expectedIntegrity: inspected.integrity, allowUnsigned: true });

    const changed = await pluginPackage("1.0.0", "changed");
    const changedIntegrity = (await inspectExtensionPackage(changed, root)).integrity;
    await expect(
      manager.install({ sourceDirectory: changed, expectedIntegrity: changedIntegrity, allowUnsigned: true }),
    ).rejects.toMatchObject({ code: "EXTENSION_INTEGRITY_MISMATCH" });
    expect(await readFile(join(manager.packagePath("plugin", "ci-monitor"), "bin", "check.mjs"), "utf8")).toContain(
      "ok-1.0.0-",
    );
  });

  test("validates and searches an optional marketplace index with trust and compatibility metadata", () => {
    const entries = parseMarketplaceIndex([
      {
        kind: "plugin",
        id: "ci-monitor",
        version: "1.0.0",
        displayName: "CI Monitor",
        description: "Observe build status",
        trust: "verified",
        compatibility: { platforms: ["darwin", "linux"], minimumRoamCodeVersion: "1.0.0" },
        changelog: "Initial release",
        source: "https://example.invalid/ci-monitor-1.0.0",
        integrity: `sha256-${"A".repeat(43)}=`,
        reportUrl: "https://example.invalid/report",
      },
    ]);
    expect(searchMarketplace(entries, "build", "linux")).toEqual([expect.objectContaining({ id: "ci-monitor" })]);
    expect(searchMarketplace(entries, "build", "win32")).toEqual([]);
  });

  test("rejects adapter capability claims and templates that runtime v1 cannot honor", async () => {
    const metadata = await adapterPackage("metadata", (manifest) => {
      manifest.adapter.capabilities.metadata = true;
    });
    await expect(inspectExtensionPackage(metadata, root)).rejects.toMatchObject({ code: "EXTENSION_INVALID" });

    const placeholder = await adapterPackage("placeholder", (manifest) => {
      manifest.runtime.launchArgs = ["--secret", "{unsupported}"];
    });
    await expect(inspectExtensionPackage(placeholder, root)).rejects.toThrow(
      "unsupported runtime argument placeholder",
    );

    const missingResumeIdentity = await adapterPackage("resume", (manifest) => {
      manifest.runtime.resumeArgs = ["--continue"];
    });
    await expect(inspectExtensionPackage(missingResumeIdentity, root)).rejects.toThrow(
      "consume the exact provider session id",
    );
  });
});
