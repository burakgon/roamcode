import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { inspectExtensionPackage, openExtensionManager } from "../src/extension-manager.js";
import type { ExtensionManager } from "../src/extension-manager.js";
import { createInstalledAdapterProvider } from "../src/providers/installed-adapter-provider.js";
import { parseProviderOptions } from "../src/providers/options.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { openSessionStore } from "../src/session-store.js";
import { TerminalManager } from "../src/terminal-manager.js";

let root: string;
let extensions: ExtensionManager | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roamcode-installed-adapter-"));
});

afterEach(async () => {
  extensions?.close();
  extensions = undefined;
  await rm(root, { recursive: true, force: true });
});

function signed(integrity: string) {
  const pair = generateKeyPairSync("ed25519");
  return {
    signature: sign(null, Buffer.from(integrity, "utf8"), pair.privateKey).toString("base64"),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function adapterPackage(): Promise<string> {
  const source = join(root, "source");
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(
    join(source, "roamcode-extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "adapter",
      adapter: {
        schemaVersion: 1,
        id: "fixture-agent",
        version: "1.0.0",
        displayName: "Fixture Agent",
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
          properties: {
            mode: { type: "string", enum: ["safe", "fast"] },
            retries: { type: "integer", minimum: 0, maximum: 3 },
          },
        },
      },
      runtime: {
        executable: "bin/fixture-agent.mjs",
        probeArgs: ["--version"],
        probeTimeoutMs: 1_000,
        launchArgs: ["--mode", "{option:mode}", "--cwd", "{cwd}", "--session", "{sessionId}"],
        resumeArgs: ["--resume", "{providerSessionId}", "--mode", "{option:mode}"],
        env: ["PATH"],
        workingPatterns: ["WORKING"],
        blockedPatterns: ["NEEDS_INPUT"],
        idlePatterns: ["IDLE"],
        identityPattern: "RID=([A-Za-z0-9-]+)",
      },
    }),
    "utf8",
  );
  await writeFile(
    join(source, "bin", "fixture-agent.mjs"),
    'if (process.argv.includes("--version")) { process.stdout.write("fixture-agent 1.0.0\\n"); } else { setInterval(() => {}, 1_000); }\n',
    { encoding: "utf8", mode: 0o700 },
  );
  return source;
}

function capturingPty() {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const ptys: EventEmitter[] = [];
  const spawn = (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ file, args: [...args], env: { ...options.env } });
    const pty = new EventEmitter() as EventEmitter & {
      write(data: string): void;
      resize(cols: number, rows: number): void;
      kill(): void;
      onData(callback: (data: string) => void): void;
      onExit(callback: (event: { exitCode: number }) => void): void;
    };
    pty.write = () => {};
    pty.resize = () => {};
    pty.kill = () => {};
    pty.onData = (callback) => void pty.on("data", callback);
    pty.onExit = (callback) => void pty.on("exit", callback);
    ptys.push(pty);
    return pty;
  };
  return { spawn, calls, ptys };
}

describe("installed adapter execution", () => {
  test("probes verified bytes, validates options, launches, resumes after restart, and fails closed when disabled or tampered", async () => {
    const packagesDir = join(root, "installed");
    const source = await adapterPackage();
    extensions = openExtensionManager({
      dbPath: join(root, "extensions.db"),
      packagesDir,
      fsRoot: root,
    });
    const inspected = await inspectExtensionPackage(source, root);
    const installed = await extensions.install({
      sourceDirectory: source,
      expectedIntegrity: inspected.integrity,
      ...signed(inspected.integrity),
    });
    expect(installed.current.trust).toBe("signed");
    extensions.setEnabled("adapter", "fixture-agent", true);

    const provider = createInstalledAdapterProvider({
      extensions,
      adapterId: "fixture-agent",
      env: { PATH: process.env.PATH, PRIVATE_FIXTURE_SECRET: "must-not-leak" },
    });
    const registry = new ProviderRegistry([]);
    registry.register(provider, "installed", true);
    await expect(provider.probe()).resolves.toMatchObject({ terminalAvailable: true, version: "1.0.0" });
    expect(() => parseProviderOptions("fixture-agent", { mode: "unsafe" }, provider.manifest.optionSchema)).toThrow(
      "not an allowed value",
    );
    const options = parseProviderOptions("fixture-agent", { mode: "safe", retries: 2 }, provider.manifest.optionSchema);

    const dbPath = join(root, "sessions.db");
    const firstStore = openSessionStore({ dbPath });
    const firstPty = capturingPty();
    const first = new TerminalManager({
      store: firstStore,
      providers: registry,
      now: () => 100,
      ptySpawn: firstPty.spawn as never,
      runTmux: () => {},
      tmuxSocket: "fixture-adapter-first",
    });
    first.create({ id: "adapter-session", cwd: root, provider: "fixture-agent", options });
    await first.attach("adapter-session", { onData: () => {} });
    const firstArgv = firstPty.calls[0]!.args;
    expect(firstArgv).toEqual(expect.arrayContaining([process.execPath, "--mode", "safe", "--cwd", root]));
    expect(firstPty.calls[0]!.env).toMatchObject({
      ROAMCODE_ADAPTER_ID: "fixture-agent",
      ROAMCODE_SESSION_ID: "adapter-session",
      ROAMCODE_LAUNCH_INTENT: "fresh",
    });
    expect(firstPty.calls[0]!.env.PRIVATE_FIXTURE_SECRET).toBeUndefined();
    firstPty.ptys[0]!.emit("data", "WORKING RID=thread-123");
    expect(first.get("adapter-session")).toMatchObject({
      activity: "working",
      identityState: "exact",
      providerSessionId: "thread-123",
    });
    expect(firstStore.get("adapter-session")).toMatchObject({
      externalAdapter: true,
      provider: "fixture-agent",
      providerSessionId: "thread-123",
      launchOptions: options,
    });
    firstStore.close();

    const restartedStore = openSessionStore({ dbPath });
    const restartedPty = capturingPty();
    const restarted = new TerminalManager({
      store: restartedStore,
      providers: registry,
      now: () => 200,
      ptySpawn: restartedPty.spawn as never,
      runTmux: () => {},
      tmuxSocket: "fixture-adapter-restarted",
    });
    restarted.rehydrate({ liveTmuxNames: ["rc-adapter-session"] });
    expect(restarted.get("adapter-session")).toMatchObject({
      provider: "fixture-agent",
      identityState: "exact",
      providerSessionId: "thread-123",
    });
    await restarted.attach("adapter-session", { onData: () => {} });
    expect(restartedPty.calls[0]!.args).toContain("attach-session");
    expect(restartedPty.calls[0]!.args).not.toContain("--mode");
    restartedPty.ptys[0]!.emit("exit", { exitCode: 0 });

    extensions.setEnabled("adapter", "fixture-agent", false);
    registry.setEnabled("fixture-agent", false);
    expect(() => restarted.create({ id: "blocked-new", cwd: root, provider: "fixture-agent", options })).toThrow(
      "provider disabled",
    );
    await expect(
      restarted.attach("adapter-session", { onData: () => {} }, undefined, { respawn: "continue" }),
    ).rejects.toThrow("provider disabled");

    extensions.setEnabled("adapter", "fixture-agent", true);
    registry.setEnabled("fixture-agent", true);
    await restarted.attach("adapter-session", { onData: () => {} }, undefined, { respawn: "continue" });
    expect(restartedPty.calls[1]!.args).toEqual(
      expect.arrayContaining([process.execPath, "--resume", "thread-123", "--mode", "safe"]),
    );
    restartedPty.ptys[1]!.emit("exit", { exitCode: 0 });

    const executable = join(extensions.packagePath("adapter", "fixture-agent"), "bin", "fixture-agent.mjs");
    await writeFile(executable, `${await readFile(executable, "utf8")}\n// tampered`, "utf8");
    await expect(provider.probe()).resolves.toMatchObject({ terminalAvailable: false });
    await expect(
      restarted.attach("adapter-session", { onData: () => {} }, undefined, { respawn: "continue" }),
    ).rejects.toThrow("integrity verification failed");
    restartedStore.close();
  });
});
