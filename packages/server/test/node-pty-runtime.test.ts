import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureNodePtySpawnHelperExecutable } from "../src/node-pty-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("node-pty runtime permissions", () => {
  test("makes the current macOS prebuilt spawn-helper executable", () => {
    const root = mkdtempSync(join(tmpdir(), "roamcode-node-pty-"));
    roots.push(root);
    const entry = join(root, "lib", "index.js");
    const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
    mkdirSync(join(root, "lib"), { recursive: true });
    mkdirSync(join(root, "prebuilds", "darwin-arm64"), { recursive: true });
    writeFileSync(entry, "");
    writeFileSync(helper, "");
    chmodSync(helper, 0o644);

    ensureNodePtySpawnHelperExecutable(() => entry, "darwin", "arm64");

    expect(statSync(helper).mode & 0o111).toBe(0o111);
  });
});
