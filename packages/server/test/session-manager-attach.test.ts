import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SessionManager } from "../src/index.js";

const RECORDER = fileURLToPath(new URL("./helpers/argv-recorder-claude.mjs", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rc-attach-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function managerWithRecorder(): SessionManager {
  const argvPath = join(dir, "argv.json");
  const mgr = new SessionManager(
    { claudeBin: process.execPath },
    {
      spawnPrefixArgs: [RECORDER],
      baseEnv: { ...process.env, RECORD_ARGV_PATH: argvPath },
      startTimeoutMs: 5000,
    },
  );
  return mgr;
}

function readArgv(): string[] {
  return JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
}

test("setAttachConfig makes a created session pass --mcp-config a FILE PATH to a 0600 file with the token", async () => {
  const mgr = managerWithRecorder();
  mgr.setAttachConfig({
    baseUrl: "http://127.0.0.1:5599",
    token: "tok-attach-secret",
    mcpScriptPath: "/abs/dist/mcp-send.js",
    dataDir: dir,
  });
  const session = await mgr.createSession({ cwd: process.cwd() });
  const argv = readArgv();

  // The arg following --mcp-config is a FILE PATH (not inline JSON).
  const i = argv.indexOf("--mcp-config");
  expect(i).toBeGreaterThanOrEqual(0);
  const cfgPath = argv[i + 1];
  expect(cfgPath).toBe(join(dir, `mcp-config-${session.id}.json`));
  expect(() => JSON.parse(cfgPath)).toThrow(); // it's a path, not a JSON document

  // REGRESSION (the finding): the access token must NOT appear anywhere in the spawned argv.
  expect(JSON.stringify(argv)).not.toContain("tok-attach-secret");

  // The file exists, is mode 0600, and carries the config (incl. RC_TOKEN).
  expect(existsSync(cfgPath)).toBe(true);
  expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect(cfg.mcpServers["remote-coder"].args).toEqual(["/abs/dist/mcp-send.js"]);
  expect(cfg.mcpServers["remote-coder"].env).toEqual({
    RC_BASE_URL: "http://127.0.0.1:5599",
    RC_SESSION_ID: session.id,
    RC_TOKEN: "tok-attach-secret",
  });
  mgr.stopSession(session.id);
});

test("the per-session mcp-config file is removed when the claude process exits", async () => {
  const mgr = managerWithRecorder();
  mgr.setAttachConfig({
    baseUrl: "http://127.0.0.1:5599",
    token: "tok-attach",
    mcpScriptPath: "/abs/dist/mcp-send.js",
    dataDir: dir,
  });
  const session = await mgr.createSession({ cwd: process.cwd() });
  const cfgPath = join(dir, `mcp-config-${session.id}.json`);
  expect(existsSync(cfgPath)).toBe(true);

  // Wait for the child to actually exit (stop closes stdin → recorder exits → cleanup runs).
  const exited = new Promise<void>((resolve) => session.process.once("exit", () => resolve()));
  mgr.stopSession(session.id);
  await exited;
  expect(existsSync(cfgPath)).toBe(false);
});

test("without setAttachConfig a spawn carries NO --mcp-config (additive feature)", async () => {
  const mgr = managerWithRecorder();
  const session = await mgr.createSession({ cwd: process.cwd() });
  expect(readArgv()).not.toContain("--mcp-config");
  mgr.stopSession(session.id);
});
