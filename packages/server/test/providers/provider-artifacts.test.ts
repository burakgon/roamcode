import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cleanupProviderArtifacts, writeProviderArtifact0600 } from "../../src/providers/provider-artifacts.js";
import type { ProviderProcessContext } from "../../src/providers/types.js";

function context(registerCleanupPaths?: (paths: readonly string[]) => void): ProviderProcessContext {
  return {
    roamSessionId: "artifact-test",
    cwd: "/work",
    intent: "fresh",
    options: { provider: "codex" },
    ...(registerCleanupPaths ? { registerCleanupPaths } : {}),
  };
}

test("writes a registered provider artifact with exact bytes and mode 0600", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "roamcode-provider-artifact-"));
  const path = join(dataDir, "token");
  const registered: string[] = [];
  const ownedPaths: string[] = [];

  try {
    expect(
      writeProviderArtifact0600(
        path,
        "exact-token-bytes",
        context((paths) => registered.push(...paths)),
        ownedPaths,
      ),
    ).toBe(true);
    expect(registered).toEqual([path]);
    expect(ownedPaths).toEqual([path]);
    expect(readFileSync(path, "utf8")).toBe("exact-token-bytes");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    cleanupProviderArtifacts(ownedPaths);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("removes the destination and propagates when cleanup registration fails", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "roamcode-provider-artifact-registration-"));
  const path = join(dataDir, "token");
  const ownedPaths: string[] = [];
  const failure = new Error("registration rejected");
  writeFileSync(path, "stale-secret", { mode: 0o600 });

  try {
    expect(() =>
      writeProviderArtifact0600(
        path,
        "new-secret",
        context(() => {
          throw failure;
        }),
        ownedPaths,
      ),
    ).toThrow(failure);
    expect(existsSync(path)).toBe(false);
    expect(ownedPaths).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("provider artifact cleanup is idempotent", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "roamcode-provider-artifact-cleanup-"));
  const path = join(dataDir, "token");
  writeFileSync(path, "secret", { mode: 0o600 });

  cleanupProviderArtifacts([path]);
  expect(existsSync(path)).toBe(false);
  expect(() => cleanupProviderArtifacts([path])).not.toThrow();
  rmSync(dataDir, { recursive: true, force: true });
});
