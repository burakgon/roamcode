// packages/server/test/helpers/test-server.ts
// Thin wrapper around createServer for terminal-related transport tests.
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { SessionManager, createServer } from "../../src/index.js";
import { TerminalManager } from "../../src/terminal-manager.js";
import { openSessionStore } from "../../src/session-store.js";
import type { CreateServerResult, ServerRuntimeConfig } from "../../src/index.js";

const TOKEN = "test-token";

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: process.cwd(),
    maxUploadBytes: 26214400,
    claude: { claudeBin: process.execPath },
  };
}

/** A fake IPty that records writes/resizes and lets tests emit data. */
interface FakePty extends EventEmitter {
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  _writes: string[];
  _resizes: [number, number][];
}

function makeFakePty(): FakePty {
  const ee = new EventEmitter() as FakePty;
  ee._writes = [];
  ee._resizes = [];
  ee.write = (d: string) => { ee._writes.push(d); };
  ee.resize = (c: number, r: number) => { ee._resizes.push([c, r]); };
  ee.kill = () => {};
  ee.onData = (cb) => void ee.on("data", cb);
  ee.onExit = (cb) => void ee.on("exit", cb);
  return ee;
}

/** Accessor object for fake pty state, keyed by session id. */
export interface FakePtyAccessor {
  /** The most recently created FakePty for the given session id. */
  lastForId(id: string): FakePty;
  /** All data strings written to write() for the given session. */
  writesFor(id: string): string[];
  /** All [cols, rows] resize pairs for the given session. */
  resizesFor(id: string): [number, number][];
}

function buildFakePtySpawn(): { ptySpawn: (file: string, args: string[]) => FakePty; accessor: FakePtyAccessor } {
  // Map from session id → last created FakePty for that session.
  const byId = new Map<string, FakePty>();

  const ptySpawn = (_file: string, args: string[]): FakePty => {
    // args[3] is the tmux session name: "rc-<uuid>"
    const tmuxName = args[3] as string | undefined;
    const id = tmuxName?.startsWith("rc-") ? tmuxName.slice(3) : (tmuxName ?? "unknown");
    const pty = makeFakePty();
    byId.set(id, pty);
    return pty;
  };

  const accessor: FakePtyAccessor = {
    lastForId(id: string): FakePty {
      const pty = byId.get(id);
      if (!pty) throw new Error(`No fake pty found for session id ${id}`);
      return pty;
    },
    writesFor(id: string): string[] {
      return byId.get(id)?._writes ?? [];
    },
    resizesFor(id: string): [number, number][] {
      return byId.get(id)?._resizes ?? [];
    },
  };

  return { ptySpawn, accessor };
}

export interface TestServer extends CreateServerResult {
  token: string;
  fakePty: FakePtyAccessor;
  /** Start listening and return the base ws:// URL (e.g. ws://127.0.0.1:PORT). */
  listen(): Promise<string>;
  /** Connect a WebSocket to the given path (after listen() has been called). */
  wsConnect(path: string): WebSocket;
}

export async function buildTestServer(opts: { terminalAvailable: boolean }): Promise<TestServer> {
  const config = configFor();
  const store = openSessionStore({ dbPath: ":memory:" });
  const { ptySpawn, accessor } = buildFakePtySpawn();
  const terminalManager = new TerminalManager({
    store,
    claudeBin: config.claude.claudeBin,
    now: () => Date.now(),
    ptySpawn: ptySpawn as never,
    runTmux: () => {},
  });
  const manager = new SessionManager(config.claude, {});
  const result = createServer(config, manager, {
    store,
    terminalAvailable: opts.terminalAvailable,
    terminalManager,
  });

  let baseWsUrl: string | undefined;

  const listen = async (): Promise<string> => {
    const address = await result.app.listen({ port: 0, host: "127.0.0.1" });
    baseWsUrl = address.replace(/^http/, "ws");
    return baseWsUrl;
  };

  const wsConnect = (path: string): WebSocket => {
    if (!baseWsUrl) throw new Error("Call listen() before wsConnect()");
    return new WebSocket(`${baseWsUrl}${path}`);
  };

  return { ...result, token: TOKEN, fakePty: accessor, listen, wsConnect };
}
