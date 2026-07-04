import { afterEach, expect, test, vi } from "vitest";
import { createServer, Updater, RUNNING_BUILD, createClaudeVersionProbe } from "../src/index.js";
import type {
  ServerRuntimeConfig,
  CreateServerResult,
  RunGit,
  UpdaterFs,
  VersionInfo,
  StoreMode,
} from "../src/index.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function memFs(seed: Record<string, string> = {}): UpdaterFs & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    writeFileSync: (p, data) => {
      files[p] = data;
    },
    mkdirSync: () => {},
    chmodSync: () => {},
  };
}

const okRunGit: RunGit = async () => ({ stdout: "", stderr: "", code: 0 });

/** Build a server with an injected Updater whose getVersion/startUpdate/readStatus are stubbed so no
 * real git/spawn runs. `lastStartArgs` records what the route passed to startUpdate (the rollback tests
 * assert the recorded targetSha is threaded through). */
let lastStartArgs: unknown[] | undefined;
function makeServer(overrides: {
  version?: Partial<VersionInfo>;
  started?: { started: boolean; reason?: string };
  startThrows?: Error;
  fs?: UpdaterFs;
  storeMode?: StoreMode;
  claudeVersion?: { stdout: string } | "throws";
}): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    dataDir: "/data",
    claude: { claudeBin: process.execPath },
  };

  const updater = new Updater({
    runGit: okRunGit,
    fs: overrides.fs ?? memFs(),
    spawn: vi.fn(() => ({ unref: vi.fn() })) as never,
    now: () => 0,
    dataDir: "/data",
    repoRoot: "/cwd",
    env: {},
    platform: "linux",
  });

  const baseVersion: VersionInfo = {
    current: "v2026.06.20 · headsha",
    latest: "v2026.06.20 · headsha",
    behind: 0,
    updatable: true,
    updateAvailable: false,
    changelog: [],
    runningBuild: RUNNING_BUILD,
    buildDrift: false,
  };
  vi.spyOn(updater, "getVersion").mockResolvedValue({ ...baseVersion, ...overrides.version });
  lastStartArgs = undefined;
  if (overrides.startThrows) {
    vi.spyOn(updater, "startUpdate").mockRejectedValue(overrides.startThrows);
  } else {
    vi.spyOn(updater, "startUpdate").mockImplementation(async (...args: unknown[]) => {
      lastStartArgs = args;
      return overrides.started ?? { started: true };
    });
  }

  // A fake claude-version probe so /diag never spawns a real binary.
  const claudeVersionProbe = createClaudeVersionProbe({
    run: async () => {
      if (overrides.claudeVersion === "throws") throw new Error("ENOENT claude");
      return overrides.claudeVersion ?? { stdout: "1.2.3 (Claude Code)" };
    },
  });

  return createServer(config, { updater, storeMode: overrides.storeMode, claudeVersionProbe });
}

let current: CreateServerResult | undefined;
afterEach(async () => {
  if (current) await current.app.close();
  current = undefined;
  vi.restoreAllMocks();
});

test("GET /version is token-gated (401 without a token)", async () => {
  current = makeServer({});
  const res = await current.app.inject({ method: "GET", url: "/version" });
  expect(res.statusCode).toBe(401);
});

test("GET /version returns the version info with a token", async () => {
  current = makeServer({
    version: {
      behind: 2,
      updateAvailable: true,
      latest: "v2026.06.25 · newsha",
      changelog: [{ sha: "a1b2c3d", subject: "new thing", group: "new", when: "2h", date: "2026-06-25T10:00:00Z" }],
    },
  });
  const res = await current.app.inject({ method: "GET", url: "/version", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.behind).toBe(2);
  expect(body.updateAvailable).toBe(true);
  expect(body.latest).toBe("v2026.06.25 · newsha");
  expect(body.changelog).toHaveLength(1);
});

test("POST /update requires confirm:true (400 otherwise)", async () => {
  current = makeServer({});
  const noConfirm = await current.app.inject({ method: "POST", url: "/update", headers: auth, payload: {} });
  expect(noConfirm.statusCode).toBe(400);
  const falseConfirm = await current.app.inject({
    method: "POST",
    url: "/update",
    headers: auth,
    payload: { confirm: false },
  });
  expect(falseConfirm.statusCode).toBe(400);
});

test("POST /update {confirm:true} returns 202 and spawns the updater", async () => {
  current = makeServer({ started: { started: true } });
  const res = await current.app.inject({
    method: "POST",
    url: "/update",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ ok: true, state: "starting" });
});

test("POST /update is token-gated (401 without a token)", async () => {
  current = makeServer({});
  const res = await current.app.inject({ method: "POST", url: "/update", payload: { confirm: true } });
  expect(res.statusCode).toBe(401);
});

test("POST /update 409s when the updater refuses (not a git checkout / wrong remote)", async () => {
  current = makeServer({ started: { started: false, reason: "not a git checkout" } });
  const res = await current.app.inject({
    method: "POST",
    url: "/update",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/not a git checkout/);
});

test("GET /update/status reads the status file", async () => {
  current = makeServer({
    fs: memFs({ "/data/update-status.json": JSON.stringify({ state: "building", phase: "building" }) }),
  });
  const res = await current.app.inject({ method: "GET", url: "/update/status", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json().state).toBe("building");
});

test("GET /update/status is idle when no status file exists, token-gated", async () => {
  current = makeServer({});
  const gated = await current.app.inject({ method: "GET", url: "/update/status" });
  expect(gated.statusCode).toBe(401);
  const ok = await current.app.inject({ method: "GET", url: "/update/status", headers: auth });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().state).toBe("idle");
});

test("GET /version surfaces runningBuild + buildDrift", async () => {
  current = makeServer({ version: { buildDrift: true } });
  const res = await current.app.inject({ method: "GET", url: "/version", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.runningBuild).toBe(RUNNING_BUILD);
  expect(body.buildDrift).toBe(true);
});

test("GET /diag is token-gated (401 without a token)", async () => {
  current = makeServer({});
  const res = await current.app.inject({ method: "GET", url: "/diag" });
  expect(res.statusCode).toBe(401);
});

test("GET /diag reports runningBuild, buildDrift, storeMode, claude, node, and the last update state", async () => {
  current = makeServer({
    version: { buildDrift: true, current: "v2026.06.20 · headsha" },
    storeMode: "memory-fallback",
    fs: memFs({ "/data/update-status.json": JSON.stringify({ state: "failed", error: "boom" }) }),
  });
  const res = await current.app.inject({ method: "GET", url: "/diag", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.runningBuild).toBe(RUNNING_BUILD);
  expect(body.buildDrift).toBe(true);
  expect(body.current).toBe("v2026.06.20 · headsha");
  expect(body.storeMode).toBe("memory-fallback");
  expect(body.claude).toEqual({ available: true, version: "1.2.3" });
  expect(body.node).toBe(process.version);
  expect(body.update.state).toBe("failed");
});

test("GET /diag degrades claude to unavailable (never 500s) when the probe fails", async () => {
  current = makeServer({ claudeVersion: "throws" });
  const res = await current.app.inject({ method: "GET", url: "/diag", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json().claude).toEqual({ available: false });
});

test("GET /diag defaults storeMode to 'sqlite' when not threaded", async () => {
  current = makeServer({});
  const res = await current.app.inject({ method: "GET", url: "/diag", headers: auth });
  expect(res.json().storeMode).toBe("sqlite");
});

// ── POST /update/rollback ──────────────────────────────────────────────────────────────────────────

test("POST /update/rollback requires confirm:true (400 otherwise) and is token-gated", async () => {
  current = makeServer({ fs: memFs({ "/data/last-good-sha": "abc1234\n" }) });
  const noTok = await current.app.inject({ method: "POST", url: "/update/rollback", payload: { confirm: true } });
  expect(noTok.statusCode).toBe(401);
  const noConfirm = await current.app.inject({ method: "POST", url: "/update/rollback", headers: auth, payload: {} });
  expect(noConfirm.statusCode).toBe(400);
});

test("POST /update/rollback 409s when NO last-good sha was ever recorded (nothing to roll back to)", async () => {
  current = makeServer({});
  const res = await current.app.inject({
    method: "POST",
    url: "/update/rollback",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/no last-good sha/i);
});

test("POST /update/rollback starts the pipeline in target-sha mode against the RECORDED sha (202)", async () => {
  current = makeServer({ fs: memFs({ "/data/last-good-sha": "abc1234\n" }) });
  const res = await current.app.inject({
    method: "POST",
    url: "/update/rollback",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ ok: true, state: "starting", target: "abc1234" });
  // The route reuses startUpdate — same pipeline, just aimed at the recorded sha.
  expect(lastStartArgs).toEqual([{ targetSha: "abc1234" }]);
});

test("POST /update/rollback 409s while an update is already running (startUpdate refuses)", async () => {
  current = makeServer({
    fs: memFs({ "/data/last-good-sha": "abc1234\n" }),
    started: { started: false, reason: "an update is already in progress" },
  });
  const res = await current.app.inject({
    method: "POST",
    url: "/update/rollback",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/already in progress/);
});

test("a garbage last-good-sha file reads as 'nothing recorded' (409, never into a git command)", async () => {
  current = makeServer({ fs: memFs({ "/data/last-good-sha": "$(rm -rf /)\n" }) });
  const res = await current.app.inject({
    method: "POST",
    url: "/update/rollback",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(409);
});
