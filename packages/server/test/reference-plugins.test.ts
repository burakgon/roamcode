import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createPluginRuntime,
  inspectExtensionPackage,
  openExtensionManager,
  type ExtensionManager,
} from "../src/index.js";

let temporary: string;
let extensions: ExtensionManager;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "roamcode-reference-plugins-"));
  extensions = openExtensionManager({
    dbPath: join(temporary, "extensions.db"),
    packagesDir: join(temporary, "installed"),
    fsRoot: process.cwd(),
  });
});

afterEach(async () => {
  extensions.close();
  await rm(temporary, { recursive: true, force: true });
});

async function install(name: string, permissions: string[]) {
  const sourceDirectory = join(process.cwd(), "examples", "plugins", name);
  const inspected = await inspectExtensionPackage(sourceDirectory, process.cwd());
  const extension = await extensions.install({
    sourceDirectory,
    expectedIntegrity: inspected.integrity,
    allowUnsigned: true,
    source: "repository-reference",
  });
  return extensions.setEnabled("plugin", extension.id, true, permissions);
}

describe("reference plugin packages", () => {
  test("prove notifications, guarded project bootstrap, and CI/release monitoring through the public runtime", async () => {
    await install("notifications", ["events:read", "notifications:write"]);
    await install("project-bootstrap", ["worktrees:write"]);
    await install("ci-release-monitor", ["ci:read", "releases:read"]);
    const runtime = createPluginRuntime({ extensions, fsRoot: process.cwd() });

    const notification = await runtime.run({
      pluginId: "desktop-notifications",
      actionId: "notify",
      context: { eventType: "attention.created", resourceType: "attention", deliver: false },
    });
    expect(JSON.parse(notification.stdout)).toMatchObject({
      delivery: "preview",
      notification: { title: "RoamCode needs you" },
    });

    const bootstrap = await runtime.run({
      pluginId: "project-bootstrap",
      actionId: "create-worktree",
      workspacePath: process.cwd(),
      context: { branch: "plugin-preview", baseRef: "HEAD", target: "roamcode-plugin-preview", apply: false },
    });
    expect(JSON.parse(bootstrap.stdout)).toMatchObject({ status: "preview" });
    expect(JSON.parse(bootstrap.stdout).command).toEqual([
      "git",
      "worktree",
      "add",
      "-b",
      "plugin-preview",
      expect.stringContaining("roamcode-plugin-preview"),
      "HEAD",
    ]);

    const monitor = await runtime.run({
      pluginId: "ci-release-monitor",
      actionId: "check",
      workspacePath: process.cwd(),
      context: { includeTags: true },
    });
    expect(JSON.parse(monitor.stdout)).toMatchObject({
      repository: basename(process.cwd()),
      clean: expect.any(Boolean),
      changedFiles: expect.any(Number),
      workflowCount: expect.any(Number),
    });
  });
});
