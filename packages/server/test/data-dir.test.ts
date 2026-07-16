import { mkdtemp, rm, readFile, writeFile, stat, symlink } from "node:fs/promises";
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

test("an existing-but-empty token file fails closed instead of silently rotating the host credential", async () => {
  const tokenPath = join(dir, "token");
  await writeFile(tokenPath, "", { mode: 0o644 });
  expect(() => resolveAccessToken({ dataDir: dir, generate: () => "REGENERATED" })).toThrow(
    "access token must be non-empty",
  );
  expect(await readFile(tokenPath, "utf8")).toBe("");
});

test("reading a legacy permissive token repairs its mode through the opened descriptor", async () => {
  const tokenPath = join(dir, "token");
  await writeFile(tokenPath, "OLD\n", { mode: 0o644 });
  const r = resolveAccessToken({ dataDir: dir, generate: () => "SHOULD-NOT-RUN" });
  expect(r).toEqual({ token: "OLD", generated: false });
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
});

test("a token symlink is rejected without reading or overwriting its target", async () => {
  const outside = join(dir, "outside-token");
  await writeFile(outside, "OUTSIDE\n", { mode: 0o600 });
  await symlink(outside, join(dir, "token"));

  expect(() => resolveAccessToken({ dataDir: dir, generate: () => "REPLACEMENT" })).toThrow(
    "access token path must be a regular file",
  );
  expect(await readFile(outside, "utf8")).toBe("OUTSIDE\n");
});

test("an oversized token file fails closed without invoking the generator", async () => {
  let generated = false;
  await writeFile(join(dir, "token"), "x".repeat(4 * 1024 + 3), { mode: 0o600 });
  expect(() =>
    resolveAccessToken({
      dataDir: dir,
      generate: () => {
        generated = true;
        return "REPLACEMENT";
      },
    }),
  ).toThrow("access token file is too large");
  expect(generated).toBe(false);
});

test("extra whitespace in a persisted token fails closed instead of changing its meaning", async () => {
  await writeFile(join(dir, "token"), "STORED\n\n", { mode: 0o600 });
  expect(() => resolveAccessToken({ dataDir: dir, generate: () => "REPLACEMENT" })).toThrow(
    "access token must be non-empty printable text without whitespace",
  );
});

test("generated tokens containing whitespace or controls are rejected before persistence", async () => {
  expect(() => resolveAccessToken({ dataDir: dir, generate: () => "unsafe token" })).toThrow(
    "access token must be non-empty printable text without whitespace",
  );
  await expect(readFile(join(dir, "token"), "utf8")).rejects.toThrow();
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
