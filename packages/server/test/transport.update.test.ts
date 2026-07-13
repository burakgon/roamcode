import { afterEach, expect, test, vi } from "vitest";
import { createServer, Updater, RUNNING_VERSION, createClaudeVersionProbe } from "../src/index.js";
import type { ServerRuntimeConfig, CreateServerResult, UpdaterFs, VersionInfo, StoreMode } from "../src/index.js";

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

/** Build a server with an injected Updater whose getVersion/startUpdate/readStatus are stubbed so no
 * network/service mutation runs. `lastStartArgs` records the exact version/rollback request. */
let lastStartArgs: unknown[] | undefined;
function makeServer(overrides: {
  version?: Partial<VersionInfo>;
  started?: { started: boolean; reason?: string; operationId?: string; target?: string };
  startThrows?: Error;
  fs?: UpdaterFs;
  storeMode?: StoreMode;
  claudeVersion?: { stdout: string } | "throws";
  previousVersion?: string;
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
    fs: overrides.fs ?? memFs(),
    spawn: vi.fn(() => ({ unref: vi.fn() })) as never,
    now: () => 0,
    dataDir: "/data",
    repoRoot: "/cwd",
    env: {},
    runningVersion: "1.0.0",
    fetchReleases: async () => ({ releases: [] }),
  });

  const baseVersion: VersionInfo = {
    current: "v1.0.0",
    latest: "v1.0.0",
    behind: 0,
    releaseCount: 0,
    updatable: true,
    updateAvailable: false,
    updateAction: "none",
    installation: "managed",
    rollbackAvailable: false,
    changelog: [],
    runningVersion: RUNNING_VERSION,
    activeVersion: RUNNING_VERSION,
    installDrift: false,
    checkStatus: "fresh",
    runningBuild: RUNNING_VERSION,
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
  vi.spyOn(updater, "readLastGoodVersion").mockReturnValue(overrides.previousVersion);

  // A fake claude-version probe so /diag never spawns a real binary.
  const claudeVersionProbe = createClaudeVersionProbe({
    run: async () => {
      if (overrides.claudeVersion === "throws") throw new Error("ENOENT claude");
      return overrides.claudeVersion ?? { stdout: "1.2.3 (Claude Code)" };
    },
  });

  return createServer(config, {
    updater,
    storeMode: overrides.storeMode,
    claudeVersionProbe,
    // This route suite never exercises terminals. Keeping capability off prevents rehydration from ever
    // adopting a live tmux session even if this file is run outside the normal Vitest setup.
    terminalAvailable: false,
  });
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
      releaseCount: 2,
      updateAvailable: true,
      updateAction: "update",
      latest: "v1.2.0",
      changelog: [
        {
          id: "1.2.0:0",
          version: "1.2.0",
          subject: "new thing",
          group: "new",
          when: "2h",
          date: "2026-06-25T10:00:00Z",
        },
      ],
    },
  });
  const res = await current.app.inject({ method: "GET", url: "/version", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.behind).toBe(2);
  expect(body.updateAvailable).toBe(true);
  expect(body.latest).toBe("v1.2.0");
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

test("POST /update threads the exact target version and returns its operation", async () => {
  current = makeServer({ started: { started: true, operationId: "op-1", target: "1.2.0" } });
  const res = await current.app.inject({
    method: "POST",
    url: "/update",
    headers: auth,
    payload: { confirm: true, target: "v1.2.0" },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ ok: true, state: "starting", operationId: "op-1", target: "1.2.0" });
  expect(lastStartArgs).toEqual([{ targetVersion: "v1.2.0" }]);
});

test("POST /update is token-gated (401 without a token)", async () => {
  current = makeServer({});
  const res = await current.app.inject({ method: "POST", url: "/update", payload: { confirm: true } });
  expect(res.statusCode).toBe(401);
});

test("POST /update 409s when the updater refuses an unmanaged process", async () => {
  current = makeServer({ started: { started: false, reason: "run 'roamcode install' to enable managed OTA" } });
  const res = await current.app.inject({
    method: "POST",
    url: "/update",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/roamcode install/);
});

test("GET /update/status reads the status file", async () => {
  current = makeServer({
    fs: memFs({ "/data/update-status.json": JSON.stringify({ state: "verifying", phase: "boot smoke" }) }),
  });
  const res = await current.app.inject({ method: "GET", url: "/update/status", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json().state).toBe("verifying");
});

test("GET /update/status is idle when no status file exists, token-gated", async () => {
  current = makeServer({});
  const gated = await current.app.inject({ method: "GET", url: "/update/status" });
  expect(gated.statusCode).toBe(401);
  const ok = await current.app.inject({ method: "GET", url: "/update/status", headers: auth });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().state).toBe("idle");
});

test("GET /version surfaces runningVersion + installDrift", async () => {
  current = makeServer({ version: { installDrift: true, buildDrift: true } });
  const res = await current.app.inject({ method: "GET", url: "/version", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.runningVersion).toBe(RUNNING_VERSION);
  expect(body.installDrift).toBe(true);
});

test("GET /diag is token-gated (401 without a token)", async () => {
  current = makeServer({});
  const res = await current.app.inject({ method: "GET", url: "/diag" });
  expect(res.statusCode).toBe(401);
});

test("GET /diag reports runningVersion, installDrift, storeMode, claude, node, and update state", async () => {
  current = makeServer({
    version: { installDrift: true, buildDrift: true, current: "v1.0.0" },
    storeMode: "memory-fallback",
    fs: memFs({ "/data/update-status.json": JSON.stringify({ state: "failed", error: "boom" }) }),
  });
  const res = await current.app.inject({ method: "GET", url: "/diag", headers: auth });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.runningVersion).toBe(RUNNING_VERSION);
  expect(body.installDrift).toBe(true);
  expect(body.current).toBe("v1.0.0");
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
  current = makeServer({ previousVersion: "1.0.0" });
  const noTok = await current.app.inject({ method: "POST", url: "/update/rollback", payload: { confirm: true } });
  expect(noTok.statusCode).toBe(401);
  const noConfirm = await current.app.inject({ method: "POST", url: "/update/rollback", headers: auth, payload: {} });
  expect(noConfirm.statusCode).toBe(400);
});

test("POST /update/rollback 409s when no previous managed version exists", async () => {
  current = makeServer({});
  const res = await current.app.inject({
    method: "POST",
    url: "/update/rollback",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/no previous managed version/i);
});

test("POST /update/rollback starts the managed pointer rollback pipeline", async () => {
  current = makeServer({ previousVersion: "1.0.0", started: { started: true, target: "1.0.0" } });
  const res = await current.app.inject({
    method: "POST",
    url: "/update/rollback",
    headers: auth,
    payload: { confirm: true },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ ok: true, state: "starting", target: "1.0.0" });
  expect(lastStartArgs).toEqual([{ rollback: true }]);
});

test("POST /update/rollback 409s while an update is already running (startUpdate refuses)", async () => {
  current = makeServer({
    previousVersion: "1.0.0",
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
