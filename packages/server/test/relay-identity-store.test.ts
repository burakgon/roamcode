import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { generateRelayIdentity } from "../src/relay-crypto.js";
import { loadOrCreateRelayIdentity } from "../src/relay-identity-store.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "roamcode-relay-identity-"));
  directories.push(value);
  return value;
}

describe("durable relay identity", () => {
  test("creates once with private file permissions and reloads the exact keypair", async () => {
    const dataDir = await directory();
    const generated = generateRelayIdentity();
    const first = loadOrCreateRelayIdentity({ dataDir, generate: () => generated, now: () => 1234 });
    expect(first).toMatchObject({ identity: generated, createdAt: 1234, generated: true });
    if (process.platform !== "win32") expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(first.path, "utf8")).not.toContain("undefined");

    const second = loadOrCreateRelayIdentity({
      dataDir,
      generate: () => {
        throw new Error("must not rotate a durable identity");
      },
    });
    expect(second).toMatchObject({ identity: generated, createdAt: 1234, generated: false });
  });

  test("repairs permissive metadata without changing key bytes", async () => {
    const dataDir = await directory();
    const first = loadOrCreateRelayIdentity({ dataDir });
    const before = readFileSync(first.path);
    chmodSync(first.path, 0o644);
    const loaded = loadOrCreateRelayIdentity({ dataDir });
    expect(readFileSync(first.path)).toEqual(before);
    expect(loaded.identity.fingerprint).toBe(first.identity.fingerprint);
    if (process.platform !== "win32") expect(statSync(first.path).mode & 0o777).toBe(0o600);
  });

  test("fails closed on corrupt, mismatched, and symlinked identity files", async () => {
    const corruptDir = await directory();
    writeFileSync(join(corruptDir, "relay-identity.json"), "not-json", { mode: 0o600 });
    expect(() => loadOrCreateRelayIdentity({ dataDir: corruptDir })).toThrow("corrupt");

    const mismatchDir = await directory();
    const first = generateRelayIdentity();
    const second = generateRelayIdentity();
    writeFileSync(
      join(mismatchDir, "relay-identity.json"),
      JSON.stringify({ version: 1, createdAt: 1, ...first, privateKey: second.privateKey }),
      { mode: 0o600 },
    );
    expect(() => loadOrCreateRelayIdentity({ dataDir: mismatchDir })).toThrow("invalid or mismatched");

    const symlinkDir = await directory();
    const target = join(symlinkDir, "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, join(symlinkDir, "relay-identity.json"));
    expect(() => loadOrCreateRelayIdentity({ dataDir: symlinkDir })).toThrow("regular file");

    const oversizedDir = await directory();
    writeFileSync(join(oversizedDir, "relay-identity.json"), "x".repeat(32 * 1024 + 1), { mode: 0o600 });
    expect(() => loadOrCreateRelayIdentity({ dataDir: oversizedDir })).toThrow("too large");
  });
});
