import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocket } from "ws";
import { createServer } from "../../src/transport.js";
import { codexMcpTokenPathFor } from "../../src/config.js";
import { deliver } from "../../src/mcp-send.js";
import { TerminalManager } from "../../src/terminal-manager.js";
import { openSessionStore, type SessionStore } from "../../src/session-store.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { createClaudeProvider } from "../../src/providers/claude-provider.js";
import { createCodexProvider } from "../../src/providers/codex-provider.js";
import { CodexAppServerClient } from "../../src/providers/codex-app-server-client.js";
import { CodexMetadataService } from "../../src/providers/codex-metadata-service.js";
import {
  createCodexThreadInventory,
  CodexThreadResolver,
  resetCodexThreadResolutionCoordinatorForTests,
} from "../../src/providers/codex-thread-resolver.js";
import type { ProviderId } from "../../src/providers/types.js";
import type { PushEvent } from "../../src/push-dispatch.js";
import type { ServerRuntimeConfig } from "../../src/server-config.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FAKE_CLAUDE = join(FIXTURE_DIR, "fake-claude.mjs");
const FAKE_CODEX = join(FIXTURE_DIR, "fake-codex.mjs");
const ACCESS_TOKEN_CANARY = "RC_TOKEN_CANARY_PROVIDER_INTEGRATION";
const ANTHROPIC_CANARY = "ANTHROPIC_API_KEY_CANARY_PROVIDER_INTEGRATION";
const OPENAI_CANARY = "OPENAI_API_KEY_CANARY_PROVIDER_INTEGRATION";

export interface FakeLaunch {
  readonly kind: "launch";
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly argv: string[];
  readonly resume?: string | null;
  readonly hasRcToken: boolean;
  readonly hasRcTokenFile?: boolean;
  readonly hasAnthropicApiKey?: boolean;
  readonly hasOpenAiApiKey?: boolean;
}

export interface AttachedTerminal {
  readonly socket: WebSocket;
  output(): string;
  controls(): unknown[];
  send(data: string): void;
  close(): Promise<void>;
}

export interface ProviderIntegrationHarness {
  readonly cwd: string;
  readonly fsRoot: string;
  readonly dataDir: string;
  readonly statePath: string;
  readonly tmuxSocket: string;
  readonly token: string;
  readonly store: SessionStore;
  readonly terminalManager: TerminalManager;
  readonly pushEvents: PushEvent[];
  createSession(provider: ProviderId, options?: Record<string, unknown>): Promise<{ id: string }>;
  attach(id: string, respawn?: "fresh" | "continue"): Promise<AttachedTerminal>;
  launches(): FakeLaunch[];
  launchFor(provider: ProviderId, ordinal?: number): FakeLaunch;
  invokeMcpTool(
    sessionId: string,
    tool: "send_file" | "send_image",
    path: string,
    caption?: string,
  ): Promise<Record<string, unknown>>;
  completeDeviceLogin(loginId: string, success: boolean): void;
  events(): unknown[];
  request(
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; json: unknown; body: string }>;
  setMetadataMode(mode: "ready" | "malformed" | "exit"): void;
  command(id: string, action: "approval" | "complete" | "exit"): void;
  sendKeys(id: string, text: string): void;
  liveTmuxNames(): string[];
  tmuxGlobalOption(name: string): string[];
  rehydrateManager(): TerminalManager;
  close(): Promise<void>;
}

export interface ProviderIntegrationHarnessOptions {
  readonly unavailableProvider?: ProviderId;
  readonly loginTtlMs?: number;
}

function parseEvents(statePath: string): unknown[] {
  return readFileSync(statePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

async function openSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("terminal WebSocket did not open")), 5_000);
    const cleanup = () => clearTimeout(timer);
    socket.once("open", () => {
      cleanup();
      resolve();
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

export async function createProviderIntegrationHarness(
  options: ProviderIntegrationHarnessOptions = {},
): Promise<ProviderIntegrationHarness> {
  resetCodexThreadResolutionCoordinatorForTests();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roamcode-providers-itg-")));
  const fsRoot = join(root, "fs");
  const cwd = join(fsRoot, "work");
  const dataDir = join(root, "data");
  const codexHome = join(root, "codex-home");
  const statePath = join(root, "fake-provider-state.jsonl");
  for (const path of [fsRoot, cwd, dataDir, codexHome]) mkdirSync(path, { recursive: true });
  writeFileSync(statePath, "", { mode: 0o600 });
  const mcpScriptPath = join(root, "mcp-send-wrapper.mjs");
  writeFileSync(mcpScriptPath, "#!/usr/bin/env node\n// Existing executable seam for provider launch acceptance.\n", {
    mode: 0o700,
  });
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_CODEX, 0o755);

  const tmuxSocket = `rcpitg-${process.pid}-${Date.now().toString(36)}`;
  if (tmuxSocket === "remote-coder") throw new Error("integration socket must not use production tmux");
  const store = openSessionStore({ dbPath: join(root, "sessions.db") });
  const providerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RC_FAKE_PROVIDER_STATE: statePath,
    CODEX_HOME: codexHome,
    ANTHROPIC_API_KEY: ANTHROPIC_CANARY,
    OPENAI_API_KEY: OPENAI_CANARY,
  };
  // A developer may run the suite from an active RoamCode terminal, whose RC_* variables describe the live
  // conversation. Never let those values enter this isolated fake-provider fixture: the harness derives its
  // own session id and credentials below, and tests must not read from or identify a developer's live session.
  for (const key of ["RC_SESSION_ID", "RC_BASE_URL", "RC_TOKEN", "RC_TOKEN_FILE"]) delete providerEnv[key];
  const appServer = new CodexAppServerClient({
    codexBin: FAKE_CODEX,
    env: providerEnv,
    timeoutMs: 2_000,
  });
  const rpc = {
    request: async <T>(method: string, params: unknown, schema: import("zod").ZodType<T>): Promise<T> => {
      await appServer.start();
      return appServer.request(method, params, schema);
    },
    onNotification: (listener: (notification: { method: string; params?: unknown }) => void) =>
      appServer.onNotification(listener),
  };
  const metadata = new CodexMetadataService(rpc, {
    codexHome,
    capabilityTimeoutMs: 2_000,
    ...(options.loginTtlMs !== undefined ? { loginTtlMs: options.loginTtlMs } : {}),
  });
  const inventoryFor = (dir: string) => createCodexThreadInventory(rpc, { cwd: dir, maxPages: 4, maxItems: 50 });
  const providers = new ProviderRegistry([
    createClaudeProvider({
      claudeBin: FAKE_CLAUDE,
      env: providerEnv,
      probe: () =>
        Promise.resolve({
          terminalAvailable: options.unavailableProvider !== "claude",
          metadataAvailable: options.unavailableProvider !== "claude",
          version: "0.0.0-fake",
        }),
    }),
    createCodexProvider({
      codexBin: FAKE_CODEX,
      env: providerEnv,
      probe: () =>
        Promise.resolve({
          terminalAvailable: options.unavailableProvider !== "codex",
          metadataAvailable: options.unavailableProvider !== "codex",
          version: "0.0.0-fake",
        }),
    }),
  ]);
  const runTmux = (args: string[]) => {
    spawnSync("tmux", args, { encoding: "utf8" });
  };
  const pushEvents: PushEvent[] = [];
  const managers = new Set<TerminalManager>();
  const makeManager = (): TerminalManager => {
    const managerRef: { current?: TerminalManager } = {};
    const recordPush = (kind: "awaiting" | "finished", id: string) => {
      const manager = managerRef.current;
      if (!manager) return;
      const meta = manager.get(id);
      if (!meta) return;
      pushEvents.push({
        kind,
        sessionId: id,
        provider: meta.provider,
        label: meta.name?.trim() || basename(meta.cwd),
        badgeCount: manager.awaitingCount(),
      });
    };
    const manager = new TerminalManager({
      store,
      providers,
      now: () => Date.now(),
      ptySpawn: pty.spawn as never,
      runTmux,
      tmuxSocket,
      onAwaiting: (id) => recordPush("awaiting", id),
      onFinished: (id, wasAttached) => {
        if (!wasAttached) recordPush("finished", id);
      },
      codexThreadResolver: (dir) =>
        new CodexThreadResolver({
          inventory: inventoryFor(dir),
          deadlineMs: 4_000,
          pollIntervalMs: 30,
          cancellationAckMs: 500,
        }),
    });
    managerRef.current = manager;
    managers.add(manager);
    return manager;
  };
  const terminalManager = makeManager();
  const config: ServerRuntimeConfig = {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: ACCESS_TOKEN_CANARY,
    fsRoot,
    maxUploadBytes: 25 * 1024 * 1024,
    dataDir,
    allowedOrigins: [],
    rateLimitRpm: 0,
    rateLimitBurst: 120,
    maxSessions: 25,
    codexBin: FAKE_CODEX,
    claude: { claudeBin: FAKE_CLAUDE },
  };
  const server = createServer(config, {
    store,
    terminalAvailable: true,
    terminalManager,
    providers,
    codexMetadata: metadata,
    codexCapabilityProbe: { get: () => metadata.probeCapabilities(cwd, inventoryFor(cwd)) },
    claudeVersionProbe: { get: () => Promise.resolve({ available: true, version: "0.0.0-fake" }) },
    pushDispatcher: { dispatch: async (event) => void pushEvents.push(event) },
  });
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  const wsOrigin = address.replace(/^http/, "ws");
  terminalManager.setAttachConfig({
    baseUrl: address,
    token: ACCESS_TOKEN_CANARY,
    mcpScriptPath,
    dataDir,
  });

  const sockets = new Set<WebSocket>();
  let closed = false;
  let currentLoginId: string | undefined;
  const auth = { authorization: `Bearer ${ACCESS_TOKEN_CANARY}` };
  const harness: ProviderIntegrationHarness = {
    cwd,
    fsRoot,
    dataDir,
    statePath,
    tmuxSocket,
    token: ACCESS_TOKEN_CANARY,
    store,
    terminalManager,
    pushEvents,
    async createSession(provider, options = {}) {
      const response = await server.app.inject({
        method: "POST",
        url: "/sessions",
        headers: auth,
        payload: { provider, cwd, options },
      });
      if (response.statusCode !== 201)
        throw new Error(`create ${provider} failed: ${response.statusCode} ${response.body}`);
      return { id: (response.json() as { session: { id: string } }).session.id };
    },
    async attach(id, respawn = "fresh") {
      const ticketResponse = await server.app.inject({ method: "POST", url: "/ws-ticket", headers: auth });
      if (ticketResponse.statusCode !== 200) throw new Error(`ticket failed: ${ticketResponse.statusCode}`);
      const ticket = (ticketResponse.json() as { ticket: string }).ticket;
      const socket = new WebSocket(
        `${wsOrigin}/sessions/${encodeURIComponent(id)}/terminal?ticket=${encodeURIComponent(ticket)}&cols=100&rows=30&respawn=${respawn}`,
      );
      sockets.add(socket);
      const chunks: string[] = [];
      const controls: unknown[] = [];
      socket.on("message", (data, isBinary) => {
        if (isBinary) chunks.push(Buffer.from(data).toString("utf8"));
        else {
          try {
            controls.push(JSON.parse(Buffer.from(data).toString("utf8")) as unknown);
          } catch {
            // Ignore non-control text frames; the terminal stream itself is always binary.
          }
        }
      });
      await openSocket(socket);
      return {
        socket,
        output: () => chunks.join(""),
        controls: () => [...controls],
        send: (data) => socket.send(JSON.stringify({ t: "i", d: data })),
        close: async () => {
          if (socket.readyState === WebSocket.CLOSED) return;
          await new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close();
          });
          sockets.delete(socket);
        },
      };
    },
    launches() {
      return parseEvents(statePath).filter(
        (entry): entry is FakeLaunch =>
          typeof entry === "object" && entry !== null && (entry as { kind?: unknown }).kind === "launch",
      );
    },
    launchFor(provider, ordinal = 0) {
      const entry = harness.launches().filter((candidate) => candidate.provider === provider)[ordinal];
      if (!entry) throw new Error(`missing ${provider} launch ${ordinal}`);
      return entry;
    },
    async invokeMcpTool(sessionId, tool, path, caption) {
      const tokenEnv =
        store.get(sessionId)?.provider === "codex"
          ? { RC_TOKEN_FILE: codexMcpTokenPathFor(dataDir, sessionId) }
          : { RC_TOKEN: ACCESS_TOKEN_CANARY };
      return deliver(
        { RC_BASE_URL: address, RC_SESSION_ID: sessionId, ...tokenEnv },
        { path, ...(caption !== undefined ? { caption } : {}), kind: tool === "send_image" ? "image" : "file" },
      );
    },
    completeDeviceLogin(loginId, success) {
      if (loginId !== currentLoginId) throw new Error("completion must target the exact active fake login");
      appendFileSync(
        statePath,
        `${JSON.stringify({ kind: "control", target: "metadata", action: "login-complete", success })}\n`,
        "utf8",
      );
      currentLoginId = undefined;
    },
    events: () => parseEvents(statePath),
    async request(method, url, payload) {
      const response = await server.app.inject({
        method,
        url,
        headers: auth,
        ...(payload !== undefined ? { payload } : {}),
      });
      let json: unknown;
      try {
        json = response.json();
      } catch {
        json = undefined;
      }
      if (method === "POST" && url === "/providers/codex/auth/login/start" && response.statusCode === 200) {
        const loginId = (json as { loginId?: unknown } | undefined)?.loginId;
        if (typeof loginId === "string") currentLoginId = loginId;
      }
      if (method === "POST" && url === "/providers/codex/auth/login/cancel" && response.statusCode === 200) {
        currentLoginId = undefined;
      }
      return { statusCode: response.statusCode, json, body: response.body };
    },
    setMetadataMode(mode) {
      appendFileSync(statePath, `${JSON.stringify({ kind: "control", target: "metadata", mode })}\n`, "utf8");
    },
    command(id, action) {
      appendFileSync(statePath, `${JSON.stringify({ kind: "control", target: id, action })}\n`, "utf8");
    },
    sendKeys(id, text) {
      spawnSync("tmux", ["-L", tmuxSocket, "send-keys", "-t", `rc-${id}`, "-l", text], { encoding: "utf8" });
    },
    liveTmuxNames() {
      const result = spawnSync("tmux", ["-L", tmuxSocket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
      });
      if (result.status !== 0) return [];
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
    tmuxGlobalOption(name) {
      const result = spawnSync("tmux", ["-L", tmuxSocket, "show-options", "-gv", name], { encoding: "utf8" });
      if (result.status !== 0) return [];
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    },
    rehydrateManager() {
      const manager = makeManager();
      manager.rehydrate({ liveTmuxNames: harness.liveTmuxNames() });
      return manager;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // already closed
        }
      }
      sockets.clear();
      const identityDeadline = Date.now() + 5_000;
      while (
        terminalManager.list().some((session) => session.provider === "codex" && session.identityState === "pending") &&
        Date.now() < identityDeadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      for (const manager of managers) {
        for (const session of manager.list()) manager.stop(session.id);
      }
      metadata.dispose();
      await appServer.stop();
      await server.app.close();
      spawnSync("tmux", ["-L", tmuxSocket, "kill-server"], { encoding: "utf8" });
      store.close();
      rmSync(root, { recursive: true, force: true });
      resetCodexThreadResolutionCoordinatorForTests();
    },
  };
  return harness;
}
