import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { inspectExtensionPackage, openExtensionManager } from "../src/extension-manager.js";
import type { ExtensionManager, PluginManifestV1 } from "../src/extension-manager.js";
import { createPluginRuntime } from "../src/plugin-runtime.js";

let root: string;
let source: string;
let workspace: string;
let extensions: ExtensionManager | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roamcode-plugin-runtime-"));
  source = join(root, "source");
  workspace = join(root, "workspace");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(workspace);
  workspace = await realpath(workspace);
  const manifest: PluginManifestV1 = {
    schemaVersion: 1,
    kind: "plugin",
    id: "runtime-proof",
    version: "1.0.0",
    displayName: "Runtime proof",
    description: "Exercises bounded subprocess behavior.",
    platforms: ["darwin", "linux"],
    permissions: ["events:read"],
    actions: [
      {
        id: "inspect",
        title: "Inspect",
        entrypoint: "bin/inspect.mjs",
        args: [],
        cwd: "workspace",
        timeoutMs: 2_000,
        maxOutputBytes: 8_192,
        permissions: ["events:read"],
      },
      {
        id: "overflow",
        title: "Overflow",
        entrypoint: "bin/overflow.mjs",
        args: [],
        cwd: "workspace",
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
        permissions: [],
      },
      {
        id: "hang",
        title: "Hang",
        entrypoint: "bin/hang.mjs",
        args: [],
        cwd: "workspace",
        timeoutMs: 100,
        maxOutputBytes: 1_024,
        permissions: [],
      },
    ],
    eventHooks: [{ event: "agent.blocked", actionId: "inspect" }],
    settingsSchema: { type: "object" },
  };
  await writeFile(join(source, "roamcode-extension.json"), JSON.stringify(manifest), "utf8");
  await writeFile(
    join(source, "bin", "inspect.mjs"),
    "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.ROAMCODE_API_TOKEN,context:JSON.parse(b)})));",
    "utf8",
  );
  await writeFile(join(source, "bin", "overflow.mjs"), "process.stdout.write('x'.repeat(4096))", "utf8");
  await writeFile(join(source, "bin", "hang.mjs"), "setTimeout(()=>{},10000)", "utf8");
  extensions = openExtensionManager({
    dbPath: join(root, "extensions.db"),
    packagesDir: join(root, "installed"),
    fsRoot: root,
  });
  const inspected = await inspectExtensionPackage(source, root);
  await extensions.install({ sourceDirectory: source, expectedIntegrity: inspected.integrity, allowUnsigned: true });
  extensions.setEnabled("plugin", "runtime-proof", true, ["events:read"]);
});

afterEach(async () => {
  extensions?.close();
  extensions = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("plugin subprocess boundary", () => {
  test("uses an explicit confined cwd, allow-listed environment, bounded context, and redacted audit", async () => {
    process.env.ROAMCODE_API_TOKEN = "must-not-leak";
    const audit = vi.fn();
    const runtime = createPluginRuntime({ extensions: extensions!, fsRoot: root, audit });
    const result = await runtime.run({
      pluginId: "runtime-proof",
      actionId: "inspect",
      workspacePath: workspace,
      context: { eventType: "agent.blocked", resourceId: "agent-1" },
    });
    expect(result.status).toBe("succeeded");
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: workspace,
      context: { eventType: "agent.blocked", resourceId: "agent-1" },
    });
    expect(result.stdout).not.toContain("must-not-leak");
    expect(runtime.hooksFor("agent.blocked")).toEqual([{ pluginId: "runtime-proof", actionId: "inspect" }]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(result.stdout);
    delete process.env.ROAMCODE_API_TOKEN;
  });

  test("rejects cwd escapes and terminates output or time abuse", async () => {
    const runtime = createPluginRuntime({ extensions: extensions!, fsRoot: root });
    await expect(
      runtime.run({ pluginId: "runtime-proof", actionId: "inspect", workspacePath: tmpdir() }),
    ).rejects.toMatchObject({ code: "PLUGIN_PATH_DENIED" });
    await expect(
      runtime.run({ pluginId: "runtime-proof", actionId: "overflow", workspacePath: workspace }),
    ).rejects.toMatchObject({ code: "PLUGIN_OUTPUT_LIMIT" });
    await expect(
      runtime.run({ pluginId: "runtime-proof", actionId: "hang", workspacePath: workspace }),
    ).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
    await writeFile(
      join(extensions!.packagePath("plugin", "runtime-proof"), "bin", "inspect.mjs"),
      "process.stdout.write('tampered')",
      "utf8",
    );
    await expect(
      runtime.run({ pluginId: "runtime-proof", actionId: "inspect", workspacePath: workspace }),
    ).rejects.toMatchObject({ code: "PLUGIN_PATH_DENIED" });
  });
});
