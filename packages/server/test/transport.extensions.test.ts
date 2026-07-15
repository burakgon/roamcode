import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createServer,
  inspectExtensionPackage,
  openCommandCenterStore,
  openControlStore,
  openDeviceStore,
  openExtensionManager,
  openSessionStore,
  ProviderRegistry,
  TerminalManager,
  type CommandCenterStore,
  type ControlStore,
  type CreateServerResult,
  type ExtensionManager,
  type PluginManifestV1,
  type ServerRuntimeConfig,
  type SessionStore,
} from "../src/index.js";

const HOST_TOKEN = "host-recovery-token";
let root: string;
let source: string;
let workspace: string;
let result: CreateServerResult | undefined;
let commandStore: CommandCenterStore;
let controlStore: ControlStore;
let extensions: ExtensionManager;
let deviceToken: string;
let sessionStore: SessionStore;
let providers: ProviderRegistry;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roamcode-transport-extension-"));
  source = join(root, "source");
  workspace = join(root, "workspace");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(workspace);
  const manifest: PluginManifestV1 = {
    schemaVersion: 1,
    kind: "plugin",
    id: "event-proof",
    version: "1.0.0",
    displayName: "Event proof",
    description: "Proves verified API installation and bounded event hooks.",
    platforms: ["darwin", "linux"],
    permissions: ["events:read"],
    actions: [
      {
        id: "observe",
        title: "Observe event",
        entrypoint: "bin/observe.mjs",
        args: [],
        cwd: "workspace",
        timeoutMs: 2_000,
        maxOutputBytes: 8_192,
        permissions: ["events:read"],
      },
    ],
    eventHooks: [{ event: "test.event", actionId: "observe" }],
    settingsSchema: { type: "object" },
  };
  await writeFile(join(source, "roamcode-extension.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(source, "bin", "observe.mjs"),
    "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.stdout.write(b));",
    "utf8",
  );

  commandStore = openCommandCenterStore({ dbPath: ":memory:", generateHostId: () => "host-1" });
  controlStore = openControlStore({ dbPath: ":memory:" });
  extensions = openExtensionManager({
    dbPath: ":memory:",
    packagesDir: join(root, "installed"),
    fsRoot: root,
  });
  const deviceStore = openDeviceStore({ dbPath: ":memory:" });
  const pairing = deviceStore.issuePairing();
  deviceToken = deviceStore.claimPairing(pairing.secret, "Phone")!.token;
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: HOST_TOKEN,
    fsRoot: root,
    dataDir: root,
    maxUploadBytes: 1024,
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
  sessionStore = openSessionStore({ dbPath: ":memory:" });
  providers = new ProviderRegistry([]);
  const terminalManager = new TerminalManager({
    store: sessionStore,
    providers,
    now: () => Date.now(),
    runTmux: () => {},
  });
  result = createServer(config, {
    terminalAvailable: true,
    store: sessionStore,
    providers,
    terminalManager,
    commandStore,
    controlStore,
    deviceStore,
    extensionManager: extensions,
  });
});

afterEach(async () => {
  await result?.app.close();
  result = undefined;
  await rm(root, { recursive: true, force: true });
});

const hostHeaders = (key: string) => ({
  authorization: `Bearer ${HOST_TOKEN}`,
  "idempotency-key": key,
});

describe("verified extension transport", () => {
  test("requires host administration, approves permissions explicitly, runs actions, and dispatches bounded hooks", async () => {
    const deniedInspect = await result!.app.inject({
      method: "POST",
      url: "/api/v1/extensions/inspect",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { sourceDirectory: source },
    });
    expect(deniedInspect.statusCode).toBe(403);
    expect(deniedInspect.json().code).toBe("HOST_ADMIN_REQUIRED");

    const inspected = await inspectExtensionPackage(source, root);
    const installed = await result!.app.inject({
      method: "POST",
      url: "/api/v1/extensions/install",
      headers: hostHeaders("install-event-proof"),
      payload: {
        sourceDirectory: source,
        expectedIntegrity: inspected.integrity,
        allowUnsigned: true,
        source: "local-test",
      },
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json().extension).toMatchObject({
      id: "event-proof",
      enabled: false,
      current: { trust: "integrity", source: "local-test" },
    });

    const deniedEnable = await result!.app.inject({
      method: "PATCH",
      url: "/api/v1/extensions/plugin/event-proof",
      headers: hostHeaders("enable-without-permission"),
      payload: { enabled: true },
    });
    expect(deniedEnable.statusCode).toBe(403);
    expect(deniedEnable.json().code).toBe("EXTENSION_PERMISSION_DENIED");

    const enabled = await result!.app.inject({
      method: "PATCH",
      url: "/api/v1/extensions/plugin/event-proof",
      headers: hostHeaders("enable-event-proof"),
      payload: { enabled: true, approvedPermissions: ["events:read"] },
    });
    expect(enabled.statusCode).toBe(200);

    const workspaceRecord = commandStore.createWorkspace({ cwd: workspace, label: "Workspace" });
    const ran = await result!.app.inject({
      method: "POST",
      url: "/api/v1/plugins/event-proof/actions/observe/run",
      headers: hostHeaders("run-event-proof"),
      payload: { workspaceId: workspaceRecord.id, context: { eventType: "manual" } },
    });
    expect(ran.statusCode).toBe(200);
    expect(JSON.parse(ran.json().result.stdout)).toEqual({ eventType: "manual" });
    expect(JSON.stringify(controlStore.listAudit())).not.toContain(ran.json().result.stdout);
    expect(controlStore.listAudit().some((record) => record.actorType === "plugin")).toBe(true);

    const sourceEvent = commandStore.appendEvent("test.event", "workspace", workspaceRecord.id, {
      privatePath: workspace,
    });
    await vi.waitFor(() => {
      expect(
        commandStore
          .listEvents(0, 100)
          .some(
            (event) =>
              event.type === "plugin.run_finished" &&
              event.resourceId === "event-proof" &&
              event.payload.originEventId === sourceEvent.id,
          ),
      ).toBe(true);
    });
    const lifecycle = commandStore
      .listEvents(0, 100)
      .find((event) => event.type === "plugin.run_finished" && event.payload.originEventId === sourceEvent.id)!;
    expect(lifecycle.payload).toMatchObject({ actionId: "observe", status: "succeeded", exitCode: 0 });
    expect(JSON.stringify(lifecycle)).not.toContain(workspace);

    const inventory = await result!.app.inject({
      method: "GET",
      url: "/api/v1/plugins",
      headers: { authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(inventory.json().plugins).toHaveLength(1);
  });

  test("refuses uninstall while enabled and preserves an explicit disabled lifecycle", async () => {
    const inspected = await inspectExtensionPackage(source, root);
    await extensions.install({
      sourceDirectory: source,
      expectedIntegrity: inspected.integrity,
      allowUnsigned: true,
    });
    extensions.setEnabled("plugin", "event-proof", true, ["events:read"]);

    const inUse = await result!.app.inject({
      method: "DELETE",
      url: "/api/v1/extensions/plugin/event-proof",
      headers: hostHeaders("uninstall-enabled"),
      payload: { confirm: true },
    });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe("EXTENSION_IN_USE");

    extensions.setEnabled("plugin", "event-proof", false);
    const removed = await result!.app.inject({
      method: "DELETE",
      url: "/api/v1/extensions/plugin/event-proof",
      headers: hostHeaders("uninstall-disabled"),
      payload: { confirm: true, purgeState: false },
    });
    expect(removed.statusCode).toBe(204);
    expect(extensions.get("plugin", "event-proof")).toBeUndefined();
  });

  test("registers an adapter through HTTP, validates native options, preserves sessions on disable, and rolls back failed enable", async () => {
    const adapterSource = join(root, "adapter-source");
    await mkdir(join(adapterSource, "bin"), { recursive: true });
    const adapterManifest = {
      schemaVersion: 1,
      kind: "adapter",
      adapter: {
        schemaVersion: 1,
        id: "transport-agent",
        version: "1.0.0",
        displayName: "Transport Agent",
        platforms: [process.platform],
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
        optionSchema: {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: { mode: { enum: ["safe", "fast"] } },
        },
      },
      runtime: {
        executable: "bin/agent.mjs",
        probeArgs: ["--version"],
        probeTimeoutMs: 1_000,
        launchArgs: ["--mode", "{option:mode}"],
        resumeArgs: ["--resume", "{providerSessionId}", "--mode", "{option:mode}"],
        env: ["PATH"],
        workingPatterns: ["WORKING"],
        blockedPatterns: ["NEEDS_INPUT"],
        idlePatterns: ["IDLE"],
        identityPattern: "RID=([A-Za-z0-9-]+)",
      },
    };
    await writeFile(join(adapterSource, "roamcode-extension.json"), JSON.stringify(adapterManifest), "utf8");
    await writeFile(
      join(adapterSource, "bin", "agent.mjs"),
      'if (process.argv.includes("--version")) process.stdout.write("1.0.0\\n"); else setInterval(()=>{},1000);',
      "utf8",
    );
    const inspected = await inspectExtensionPackage(adapterSource, root);
    const installed = await result!.app.inject({
      method: "POST",
      url: "/api/v1/extensions/install",
      headers: hostHeaders("install-transport-agent"),
      payload: { sourceDirectory: adapterSource, expectedIntegrity: inspected.integrity, allowUnsigned: true },
    });
    expect(installed.statusCode).toBe(201);
    expect(providers.descriptors()).toEqual([
      expect.objectContaining({ id: "transport-agent", enabled: false, source: "installed" }),
    ]);

    const disabledCreate = await result!.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: hostHeaders("disabled-adapter-session"),
      payload: { provider: "transport-agent", cwd: workspace, options: { mode: "safe" } },
    });
    expect(disabledCreate.statusCode).toBe(503);
    expect(disabledCreate.json().code).toBe("PROVIDER_UNAVAILABLE");

    const enabled = await result!.app.inject({
      method: "PATCH",
      url: "/api/v1/extensions/adapter/transport-agent",
      headers: hostHeaders("enable-transport-agent"),
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(providers.isEnabled("transport-agent")).toBe(true);

    const invalid = await result!.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: hostHeaders("invalid-adapter-session"),
      payload: { provider: "transport-agent", cwd: workspace, options: { mode: "unsafe" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("INVALID_PROVIDER_OPTIONS");

    const created = await result!.app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: hostHeaders("valid-adapter-session"),
      payload: { provider: "transport-agent", cwd: workspace, options: { mode: "safe" } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({ provider: "transport-agent", cwd: workspace });
    const sessionId = created.json().session.id as string;
    expect(sessionStore.get(sessionId)).toMatchObject({
      provider: "transport-agent",
      externalAdapter: true,
      launchOptions: { provider: "transport-agent", mode: "safe" },
    });

    const adapterUpdate = join(root, "adapter-update");
    await mkdir(join(adapterUpdate, "bin"), { recursive: true });
    const updatedManifest = structuredClone(adapterManifest);
    updatedManifest.adapter.version = "1.1.0";
    await writeFile(join(adapterUpdate, "roamcode-extension.json"), JSON.stringify(updatedManifest), "utf8");
    await writeFile(
      join(adapterUpdate, "bin", "agent.mjs"),
      'if (process.argv.includes("--version")) process.stdout.write("1.1.0\\n"); else setInterval(()=>{},1000);',
      "utf8",
    );
    const inspectedUpdate = await inspectExtensionPackage(adapterUpdate, root);
    const updated = await result!.app.inject({
      method: "POST",
      url: "/api/v1/extensions/install",
      headers: hostHeaders("update-transport-agent"),
      payload: {
        sourceDirectory: adapterUpdate,
        expectedIntegrity: inspectedUpdate.integrity,
        allowUnsigned: true,
      },
    });
    expect(updated.statusCode).toBe(201);
    expect(providers.descriptors()).toEqual([
      expect.objectContaining({ id: "transport-agent", version: "1.1.0", enabled: true }),
    ]);

    const rolledBack = await result!.app.inject({
      method: "POST",
      url: "/api/v1/extensions/adapter/transport-agent/rollback",
      headers: hostHeaders("rollback-transport-agent"),
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(providers.descriptors()).toEqual([
      expect.objectContaining({ id: "transport-agent", version: "1.0.0", enabled: true }),
    ]);

    const disabled = await result!.app.inject({
      method: "PATCH",
      url: "/api/v1/extensions/adapter/transport-agent",
      headers: hostHeaders("disable-transport-agent"),
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(result!.terminalManager.get(sessionId)).toBeDefined();

    const uninstallInUse = await result!.app.inject({
      method: "DELETE",
      url: "/api/v1/extensions/adapter/transport-agent",
      headers: hostHeaders("uninstall-adapter-in-use"),
      payload: { confirm: true },
    });
    expect(uninstallInUse.statusCode).toBe(409);
    expect(uninstallInUse.json().code).toBe("EXTENSION_IN_USE");
    expect(extensions.get("adapter", "transport-agent")).toBeDefined();
    expect(providers.source("transport-agent")).toBe("installed");

    const installedExecutable = join(extensions.packagePath("adapter", "transport-agent"), "bin", "agent.mjs");
    await writeFile(installedExecutable, "// tampered", "utf8");
    const failedEnable = await result!.app.inject({
      method: "PATCH",
      url: "/api/v1/extensions/adapter/transport-agent",
      headers: hostHeaders("enable-tampered-agent"),
      payload: { enabled: true },
    });
    expect(failedEnable.statusCode).toBe(409);
    expect(failedEnable.json().code).toBe("EXTENSION_INTEGRITY_MISMATCH");
    expect(extensions.get("adapter", "transport-agent")?.enabled).toBe(false);
    expect(providers.isEnabled("transport-agent")).toBe(false);
    expect(result!.terminalManager.get(sessionId)).toBeDefined();
  });
});
