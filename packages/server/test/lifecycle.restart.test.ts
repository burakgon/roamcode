import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createClaudeProvider,
  createCodexProvider,
  createServer,
  openCommandCenterStore,
  openControlStore,
  openSessionStore,
  ProviderRegistry,
  TerminalManager,
} from "../src/index.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../src/index.js";

const TOKEN = "restart-token";
const auth = { authorization: `Bearer ${TOKEN}` };
let dir: string;
let apps: CreateServerResult[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roamcode-restart-"));
});

afterEach(async () => {
  await Promise.all(apps.map((result) => result.app.close().catch(() => undefined)));
  apps = [];
  await rm(dir, { recursive: true, force: true });
});

function fakePty(spawned: ReturnType<typeof vi.fn>) {
  return () => {
    spawned();
    const emitter = new EventEmitter() as EventEmitter & {
      write(value: string): void;
      resize(cols: number, rows: number): void;
      kill(): void;
      onData(callback: (value: string) => void): void;
      onExit(callback: (value: { exitCode: number }) => void): void;
    };
    emitter.write = () => undefined;
    emitter.resize = () => undefined;
    emitter.kill = () => undefined;
    emitter.onData = (callback) => void emitter.on("data", callback);
    emitter.onExit = (callback) => void emitter.on("exit", callback);
    return emitter;
  };
}

function boot(spawned: ReturnType<typeof vi.fn>): CreateServerResult {
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: dir,
    dataDir: dir,
    maxUploadBytes: 1024,
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: process.execPath,
    claude: { claudeBin: process.execPath },
  };
  const store = openSessionStore({ dbPath: join(dir, "sessions.db") });
  const commandStore = openCommandCenterStore({ dbPath: join(dir, "command.db") });
  const controlStore = openControlStore({ dbPath: join(dir, "control.db") });
  const providers = new ProviderRegistry([
    createClaudeProvider({ claudeBin: process.execPath }),
    createCodexProvider({ codexBin: process.execPath }),
  ]);
  const terminalManager = new TerminalManager({
    store,
    providers,
    now: () => Date.now(),
    ptySpawn: fakePty(spawned) as never,
    runTmux: () => undefined,
  });
  terminalManager.rehydrate({ liveTmuxNames: store.list().map((session) => `rc-${session.id}`) });
  const result = createServer(config, {
    store,
    commandStore,
    controlStore,
    providers,
    terminalManager,
    terminalAvailable: true,
  });
  apps.push(result);
  return result;
}

describe("restart-safe lifecycle", () => {
  test("replays workspace and session mutations after a full store reopen without duplicate processes", async () => {
    const firstSpawn = vi.fn();
    const first = boot(firstSpawn);
    const workspaceRequest = {
      method: "POST" as const,
      url: "/api/v1/workspaces",
      headers: { ...auth, "idempotency-key": "workspace-once" },
      payload: { cwd: dir, label: "Restart proof" },
    };
    const workspace = await first.app.inject(workspaceRequest);
    expect(workspace.statusCode).toBe(201);
    const sessionRequest = {
      method: "POST" as const,
      url: "/api/v1/sessions",
      headers: { ...auth, "idempotency-key": "session-once" },
      payload: { cwd: dir, provider: "claude" },
    };
    const session = await first.app.inject(sessionRequest);
    expect(session.statusCode).toBe(201);
    expect(
      (await first.app.inject({ method: "GET", url: "/api/v1/sessions", headers: auth })).json().sessions,
    ).toHaveLength(1);
    // Session creation persists metadata; the provider process remains lazy until a terminal attaches.
    expect(firstSpawn).not.toHaveBeenCalled();
    await first.app.close();
    apps = apps.filter((app) => app !== first);

    const persisted = openSessionStore({ dbPath: join(dir, "sessions.db") });
    expect(persisted.list()).toHaveLength(1);
    persisted.close();

    const secondSpawn = vi.fn();
    const second = boot(secondSpawn);
    const workspaceReplay = await second.app.inject(workspaceRequest);
    const sessionReplay = await second.app.inject(sessionRequest);
    expect(workspaceReplay.headers["idempotency-replayed"]).toBe("true");
    expect(sessionReplay.headers["idempotency-replayed"]).toBe("true");
    expect(secondSpawn).not.toHaveBeenCalled();
    expect(
      (await second.app.inject({ method: "GET", url: "/api/v1/workspaces", headers: auth })).json().workspaces,
    ).toHaveLength(1);
    expect(
      (await second.app.inject({ method: "GET", url: "/api/v1/sessions", headers: auth })).json().sessions,
    ).toHaveLength(1);
  });
});
