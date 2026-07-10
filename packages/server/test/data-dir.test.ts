import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveDataDir, ensureDataDir, resolveAccessToken } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-data-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("resolveDataDir prefers ROAMCODE_DATA_DIR, then XDG, then HOME/.config", () => {
  expect(resolveDataDir({ ROAMCODE_DATA_DIR: "/explicit" } as NodeJS.ProcessEnv)).toBe("/explicit");
  expect(resolveDataDir({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe("/xdg/roamcode");
  expect(resolveDataDir({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe("/home/u/.config/roamcode");
});

// Rename compat (Remote Coder → RoamCode): a pre-rename install must keep finding its existing data
// (token / service.json / session index) after an OTA update — losing it would sign the user out.
test("resolveDataDir honors the legacy REMOTE_CODER_DATA_DIR env (new name still wins)", () => {
  expect(resolveDataDir({ REMOTE_CODER_DATA_DIR: "/legacy" } as NodeJS.ProcessEnv)).toBe("/legacy");
  expect(resolveDataDir({ ROAMCODE_DATA_DIR: "/new", REMOTE_CODER_DATA_DIR: "/legacy" } as NodeJS.ProcessEnv)).toBe(
    "/new",
  );
});

test("resolveDataDir uses an EXISTING legacy remote-coder dir, but only when no roamcode dir exists", () => {
  const env = { HOME: "/home/u" } as NodeJS.ProcessEnv;
  expect(resolveDataDir(env, (p) => p === "/home/u/.config/remote-coder")).toBe("/home/u/.config/remote-coder");
  expect(resolveDataDir(env, () => true)).toBe("/home/u/.config/roamcode"); // both exist → new name wins
  expect(resolveDataDir(env, () => false)).toBe("/home/u/.config/roamcode"); // fresh install → new name
  const xdg = { XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv;
  expect(resolveDataDir(xdg, (p) => p === "/xdg/remote-coder")).toBe("/xdg/remote-coder");
});

test("ensureDataDir creates the directory (idempotent)", async () => {
  const target = join(dir, "nested", "roamcode");
  ensureDataDir(target);
  ensureDataDir(target); // no throw on re-run
  expect((await stat(target)).isDirectory()).toBe(true);
});

test("a configured token is used verbatim and NOT persisted (generated=false)", async () => {
  const r = resolveAccessToken({ configured: "env-token", dataDir: dir });
  expect(r).toEqual({ token: "env-token", generated: false });
  await expect(readFile(join(dir, "token"), "utf8")).rejects.toThrow(); // nothing written
});

test("no configured + no file -> generates, persists with mode 0600, generated=true", async () => {
  const r = resolveAccessToken({ dataDir: dir, generate: () => "GENERATED" });
  expect(r.generated).toBe(true);
  expect(r.token).toBe("GENERATED");
  const persisted = (await readFile(join(dir, "token"), "utf8")).trim();
  expect(persisted).toBe("GENERATED");
  const mode = (await stat(join(dir, "token"))).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("an existing token file is reused (generated=false, no regeneration)", async () => {
  await writeFile(join(dir, "token"), "STORED\n", { mode: 0o600 });
  const r = resolveAccessToken({ dataDir: dir, generate: () => "SHOULD-NOT-RUN" });
  expect(r).toEqual({ token: "STORED", generated: false });
});

test("an existing-but-EMPTY token file (mode 0644) -> regenerates AND ends at mode 0600", async () => {
  const tokenPath = join(dir, "token");
  // Empty file pre-created world-readable: the empty-file guard falls through to
  // regenerate-and-overwrite, where writeFileSync's `mode` option is ignored.
  await writeFile(tokenPath, "", { mode: 0o644 });
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o644); // precondition

  const r = resolveAccessToken({ dataDir: dir, generate: () => "REGENERATED" });
  expect(r.generated).toBe(true);
  expect(r.token).toBe("REGENERATED");
  expect((await readFile(tokenPath, "utf8")).trim()).toBe("REGENERATED");
  // Without the post-write chmodSync this stays 0644 (the security defect).
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
});

test("regenerating over a pre-existing token file ends at mode 0600", async () => {
  const tokenPath = join(dir, "token");
  await writeFile(tokenPath, "OLD\n", { mode: 0o644 });
  // Drop the stored token so the empty/missing guard regenerates over it.
  await writeFile(tokenPath, "", { mode: 0o644 });
  const r = resolveAccessToken({ dataDir: dir, generate: () => "NEW" });
  expect(r.generated).toBe(true);
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
});

test("the default generator produces strong (>=32 byte) base64url randomness, distinct per call", async () => {
  const a = resolveAccessToken({ dataDir: dir });
  await rm(join(dir, "token"), { force: true });
  const b = resolveAccessToken({ dataDir: dir });
  // 32 random bytes -> 43 base64url chars (no padding).
  expect(a.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  expect(b.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  expect(a.token).not.toBe(b.token);
});
