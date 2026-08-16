// packages/server/src/terminal-manager.ts
import { accessSync, constants, realpathSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  TerminalProcess,
  tmuxSessionName,
  TMUX_SOCKET,
  type PtySpawn,
  type TmuxTerminalState,
} from "./terminal-process.js";
import { capturePane, capturePaneTitles, type PaneStatus } from "./pane-status.js";
import { CODEX_HOOK_SCRIPT_PREFIX, CODEX_MCP_TOKEN_PREFIX, type AttachSpawnOptions } from "./config.js";
import { isStoredShellSession, type SessionStore } from "./session-store.js";
import { parseLegacyClaudeArgs } from "./providers/options.js";
import { ProviderRegistry } from "./providers/registry.js";
import {
  ProviderError,
  type AgentProvider,
  type ClaudeSessionOptions,
  type CodexSessionOptions,
  type ProviderId,
  type ProviderPaneClassification,
  type ProviderRuntimeSignal,
  type ProviderSessionOptions,
} from "./providers/types.js";
import { createCodexThreadPersistence } from "./providers/codex-thread-persistence.js";
import { codexThreadResolutionCoordinator } from "./providers/codex-thread-coordinator.js";
import type { CodexThreadResolver } from "./providers/codex-thread-resolver.js";
import {
  captureForegroundProcessSnapshot,
  identifyForegroundAgent,
  type ForegroundProcessSnapshot,
} from "./foreground-agent-detector.js";

export type TerminalAgentSource = "managed" | "process" | "integration";

export interface TerminalAgentMeta {
  provider: ProviderId;
  source: TerminalAgentSource;
  activity: PaneStatus;
  model?: string;
  effort?: string;
  identityState?: "pending" | "exact" | "ambiguous";
  providerSessionId?: string;
}

export type TerminalLaunchMeta = { kind: "shell" } | { kind: "managed"; provider: ProviderId };

export interface TerminalMeta {
  id: string;
  launch: TerminalLaunchMeta;
  agent?: TerminalAgentMeta;
  /** Compatibility projection for older clients. Absent while a shell has no detected foreground agent. */
  provider?: ProviderId;
  cwd: string;
  mode: "terminal";
  status: "running" | "ended";
  createdAt: number;
  lastActivityAt: number;
  /**
   * The session's LIVE activity, derived every ~2.5s from its rendered tmux pane by the capture-pane monitor
   * (TerminalManager.refreshActivity → pane-status.classifyPaneStatus). UNIVERSAL (no hooks) + works while
   * detached. Surfaced in GET /sessions to drive the rail's per-session status:
   *   - "working" — actively generating (main spinner OR background agents still developing);
   *   - "blocked" — claude is WAITING ON YOUR DECISION (a permission or plan prompt) → the loud
   *     "needs you". This is the ONLY state that alerts;
   *   - "idle"    — a finished turn sitting at an empty prompt, nothing running, nothing to decide (calm).
   */
  activity: PaneStatus;
  /**
   * Back-compat boolean = `activity === "blocked"`. Drives the loud "needs you" badge/chip, the away push, and
   * the badge count. Kept as a distinct field so existing consumers (awaitingCount, the push gate) don't all
   * have to learn the 3-state enum. Set together with `activity` by the monitor.
   */
  awaiting: boolean;
  /**
   * Whether this session's claude runs with `--dangerously-skip-permissions` (RCE-by-design: claude can run
   * any tool without asking). Derived at create() from the spawn args, persisted, and surfaced in GET /sessions
   * so the web rail can badge a session as running in skip-permissions mode.
   */
  dangerouslySkip: boolean;
  /** The effective model: initialized from launch options, then refreshed from live provider chrome when the
   *  TUI exposes it. Surfaced in GET /sessions so the chat header/rail follow in-session changes. */
  model?: string;
  /** Effective effort/reasoning: initialized from launch options, then refreshed from live provider chrome.
   *  Absent means the provider controls its default. */
  effort?: string;
  /** Provider-native safety controls captured at launch for exact UI display. */
  permissionMode?: ClaudeSessionOptions["permissionMode"];
  sandbox?: CodexSessionOptions["sandbox"];
  approvalPolicy?: CodexSessionOptions["approvalPolicy"];
  /** User-set display name (PATCH /sessions/:id). SERVER-side so a rename shows on every device, not just
   *  the one that typed it. Persisted; absent = unnamed (the UI falls back to the cwd). */
  name?: string;
  /** Codex exact-thread capture state. Claude sessions do not need a provider resume identity. */
  identityState?: "pending" | "exact" | "ambiguous";
  providerSessionId?: string;
}

export interface TerminalSub {
  unsubscribe(): void;
  /** Report whether this attached browser is actually foregrounded/focused. */
  setViewing(viewing: boolean): void;
  /** Report whether this browser's acknowledged output window is currently full. */
  setOutputPressure(pressured: boolean): void;
}

/** A single attached client: its output sink, an optional exit notifier, and an optional out-of-band
 *  CONTROL channel (JSON strings) used to push file/image attachments to the client. */
interface TermSub {
  onData: (chunk: string) => void;
  onExit?: () => void;
  onControl?: (msg: string) => void;
  releaseAbortListener: () => void;
  viewing: boolean;
  outputPressured: boolean;
}

interface RecordBase {
  meta: TerminalMeta;
  cols: number;
  rows: number;
  proc?: TerminalProcess;
  spawnPromise?: Promise<TerminalProcess | undefined>;
  spawnIntent?: "fresh" | "resume";
  subs: Set<TermSub>;
  cleanupPaths: Set<string>;
  /**
   * Bounded, in-memory buffer of `attach` control frames (files/images claude sent) so a client that
   * (re)connects LATER still sees files that arrived while it was away — pushControl only reaches clients
   * attached at send-time. Replayed to each newly-attached client. Not durable across a server restart.
   */
  attachments: unknown[];
  /** True only for a record adopted from a proven live tmux inventory after server restart. */
  adoptedLive: boolean;
  /** Provider-native lifecycle evidence outranks stale pane chrome until the provider reports another state. */
  runtimeActivity?: PaneStatus;
  /** Lifecycle hooks are stronger than display-derived OSC fallback when deciding whether user input resumes. */
  runtimeActivitySource?: "lifecycle" | "runtime" | "input";
}

type ManagedRecord = RecordBase & {
  kind: "managed";
  provider: ProviderId;
  options: ProviderSessionOptions;
  providerSessionId?: string;
  identityAmbiguous: boolean;
};

type ShellRecord = RecordBase & {
  kind: "shell";
  shellExecutable: string;
  detectionMisses: number;
};

type Record_ = ManagedRecord | ShellRecord;

export interface TerminalManagerDeps {
  store: SessionStore;
  providers: ProviderRegistry;
  now: () => number;
  ptySpawn?: PtySpawn;
  runTmux?: (args: string[]) => void;
  /** Read-only live pane mode used to put a newly attached browser into the same normal/alternate buffer. */
  readTmuxAlternateScreen?: (sessionName: string) => boolean | undefined;
  /** Read-only standard DEC state used to restore mouse/cursor/keypad modes on a newly attached mirror. */
  readTmuxTerminalState?: (sessionName: string) => TmuxTerminalState | undefined;
  /** Read-only ANSI history capture used to hydrate a browser terminal after a server/PWA reconnect. */
  readTmuxHistorySeed?: (sessionName: string) => string | undefined;
  /** Dedicated tmux server socket. Defaults to the unchanged production socket; integration tests inject a
   * unique socket so spawn, capture, resume, and cleanup cannot touch a live RoamCode instance. */
  tmuxSocket?: string;
  /**
   * Best-effort notifier fired on a false→true `awaiting` transition when no attached client is actively
   * visible. A background PWA socket does not suppress the alert. Wired by the transport to push. Called in
   * a try/catch — a throw here can NEVER break the terminal.
   */
  onAwaiting?: (id: string) => void;
  /**
   * Best-effort notifier fired when a session exits (the "done" ping). `wasViewed` reports whether any client
   * was foregrounded at that moment, captured before subscribers are torn down. Same never-throw contract.
   */
  onFinished?: (id: string, wasViewed: boolean) => void;
  /** Every semantic state transition, including ones observed while a browser is attached. Used by the
   * command-center event/attention layer; a failure is isolated from terminal state. */
  onActivityChanged?: (id: string, previous: PaneStatus, current: PaneStatus, viewed: boolean) => void;
  /** Foreground agent identity changed inside a shell-first Session. Undefined means the shell is neutral. */
  onAgentChanged?: (
    id: string,
    previous: TerminalAgentMeta | undefined,
    current: TerminalAgentMeta | undefined,
  ) => void;
  /** A client foregrounded this terminal. Done-unseen attention can become seen; blocked attention stays. */
  onViewed?: (id: string) => void;
  /**
   * Capture a tmux session's CURRENT rendered pane as plain text (READ-ONLY). Injected for tests; in
   * production it defaults to a real `capture-pane -p` on {@link TMUX_SOCKET}. Drives {@link refreshActivity},
   * the universal (hook-free) working-vs-awaiting classifier.
   */
  capturePane?: (sessionName: string) => Promise<string>;
  /** One read-only title inventory per sweep. Tests that inject capturePane may omit this and receive no
   * title evidence; production defaults to tmux list-panes. */
  capturePaneTitles?: () => Promise<ReadonlyMap<string, string>>;
  /** One bounded system-wide snapshot per monitor tick; injected so tests never inspect developer processes. */
  captureForegroundProcesses?: () => Promise<ForegroundProcessSnapshot | undefined>;
  /** Builds the cwd-scoped exact-thread resolver used around a fresh Codex TUI spawn. */
  codexThreadResolver?: (cwd: string) => CodexThreadResolver;
}

/** Cap the per-session replay buffer of attachment frames so a long-lived session can't grow unbounded. */
const MAX_ATTACHMENT_BUFFER = 50;
const MAX_TERMINAL_REPLAY_BYTES = 12 * 1024 * 1024;
const PLAIN_IDLE_CONFIRMATIONS = 3;
const PLAIN_IDLE_RECHECK_MS = 100;

/** A bounded server-owned copy of exact PTY bytes. Herdr keeps the terminal model in its server; this lighter
 * equivalent preserves the same reconnect invariant for RoamCode's browser-owned xterm surface. A tmux ANSI
 * seed initializes adopted sessions, then every live byte is retained once and replayed to later clients. */
class TerminalReplayBuffer {
  private chunks: Array<{ data: string; bytes: number }> = [];
  private head = 0;
  private bytes = 0;
  private truncated = false;

  get empty(): boolean {
    return this.bytes === 0;
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.bytes = 0;
    this.truncated = false;
  }

  replace(chunk: string): void {
    this.clear();
    this.append(chunk);
  }

  append(chunk: string): void {
    if (!chunk) return;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    this.chunks.push({ data: chunk, bytes: chunkBytes });
    this.bytes += chunkBytes;
    while (this.bytes > MAX_TERMINAL_REPLAY_BYTES && this.chunks.length - this.head > 1) {
      const removed = this.chunks[this.head++];
      if (removed) this.bytes -= removed.bytes;
      this.truncated = true;
    }
    // Avoid retaining a large dead prefix after spinner/paint chunks have been evicted.
    if (this.head > 1_024 || this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    if (this.bytes <= MAX_TERMINAL_REPLAY_BYTES) return;
    const tail = Buffer.from(this.chunks[this.head]?.data ?? "", "utf8")
      .subarray(-MAX_TERMINAL_REPLAY_BYTES)
      .toString("utf8");
    this.chunks = [{ data: tail, bytes: Buffer.byteLength(tail, "utf8") }];
    this.head = 0;
    this.bytes = Buffer.byteLength(tail, "utf8");
    this.truncated = true;
  }

  snapshot(): string | undefined {
    // Raw PTY bytes are replayable only from their original terminal state. Once the prefix was evicted, a
    // tail may begin inside an escape sequence or depend on an older DEC mode. The caller must refresh from
    // tmux's authoritative rendered history instead of guessing how to repair that stream.
    return this.truncated
      ? undefined
      : this.chunks
          .slice(this.head)
          .map((chunk) => chunk.data)
          .join("");
  }
}

const clampDim = (n: number | undefined, fallback: number): number =>
  Math.max(1, Math.trunc(n ?? fallback) || fallback);

function basicPaneClassification(activity: PaneStatus): ProviderPaneClassification {
  return {
    activity,
    visibleWorking: false,
    visibleBlocked: false,
    visibleIdle: false,
  };
}

function isPlainIdle(classification: ProviderPaneClassification): boolean {
  return (
    classification.activity === "idle" &&
    !classification.visibleIdle &&
    !classification.visibleBlocked &&
    !classification.visibleWorking &&
    !classification.skipStateUpdate
  );
}

function recheckDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PLAIN_IDLE_RECHECK_MS));
}

function resolveInteractiveShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.SHELL, process.platform === "darwin" ? "/bin/zsh" : undefined, "/bin/bash", "/bin/sh"].filter(
    (value): value is string => Boolean(value?.startsWith("/")),
  );
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Try the next ordinary system shell. Never invoke a shell parser to resolve this path.
    }
  }
  throw new Error("No executable interactive shell is available");
}

function claudeArgsOf(options: ClaudeSessionOptions): string[] {
  const args: string[] = [];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.dangerouslySkip) args.push("--dangerously-skip-permissions");
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  args.push(...(options.legacyArgs ?? []));
  return args;
}

type CreateTerminalOptions = {
  id: string;
  cwd: string;
  provider: ProviderId;
  options: ProviderSessionOptions;
  cols?: number;
  rows?: number;
};

type CreateShellTerminalOptions = {
  id: string;
  cwd: string;
  cols?: number;
  rows?: number;
};

type LegacyCreateTerminalOptions = {
  id: string;
  cwd: string;
  claudeArgs?: string[];
  cols?: number;
  rows?: number;
};

export class TerminalManager {
  private readonly records = new Map<string, Record_>();
  private readonly terminalReplay = new Map<string, TerminalReplayBuffer>();
  private readonly providers: ProviderRegistry;
  private attachConfig?: AttachSpawnOptions;
  constructor(private readonly deps: TerminalManagerDeps) {
    this.providers = deps.providers;
  }

  private notifyActivityChanged(id: string, previous: PaneStatus, current: PaneStatus, rec: Record_): void {
    if (previous === current) return;
    try {
      this.deps.onActivityChanged?.(id, previous, current, this.hasActiveViewer(rec));
    } catch {
      /* command-center bookkeeping must never interrupt the terminal */
    }
  }

  private replayFor(id: string): TerminalReplayBuffer {
    let replay = this.terminalReplay.get(id);
    if (!replay) {
      replay = new TerminalReplayBuffer();
      this.terminalReplay.set(id, replay);
    }
    return replay;
  }

  private fanoutTerminalData(id: string, rec: Record_, chunk: string): void {
    this.replayFor(id).append(chunk);
    for (const sink of [...rec.subs]) {
      try {
        sink.onData(chunk);
      } catch {
        /* ignore a bad sink */
      }
    }
  }

  /** Replay is deliberately bracketed on the text control channel. Rebuilding a fresh xterm instance from
   * historical PTY bytes must not repeat output-side effects such as OSC 52 clipboard writes. The browser keeps
   * rendering every byte, but suppresses those effects until the matching end marker arrives. */
  private deliverTerminalReplay(sub: TermSub, replay: string): void {
    try {
      sub.onControl?.(JSON.stringify({ t: "terminal-replay", phase: "begin" }));
    } catch {
      /* replay remains useful for clients without a control sink */
    }
    try {
      sub.onData(replay);
    } catch {
      /* ignore a bad sink */
    } finally {
      try {
        sub.onControl?.(JSON.stringify({ t: "terminal-replay", phase: "end" }));
      } catch {
        /* ignore a bad sink */
      }
    }
  }

  private prepareTerminalReplay(id: string, rec: Record_, candidate: TerminalProcess, adoptingLive: boolean): void {
    const replay = this.replayFor(id);
    if (!adoptingLive) {
      replay.clear();
      return;
    }
    if (!replay.empty) return;
    const fallbackAlternate = rec.kind === "managed" && rec.provider === "claude";
    const seed = candidate.historySeed(fallbackAlternate);
    if (!seed) return;
    replay.replace(seed);
    for (const sub of [...rec.subs]) this.deliverTerminalReplay(sub, seed);
  }

  private terminalReplaySnapshot(id: string, rec: Record_): string | undefined {
    const replay = this.terminalReplay.get(id);
    const snapshot = replay?.snapshot();
    if (snapshot) return snapshot;
    if (!rec.proc || !replay || replay.empty) return undefined;
    const fallbackAlternate = rec.kind === "managed" && rec.provider === "claude";
    const seed = rec.proc.historySeed(fallbackAlternate);
    if (!seed) return undefined;
    replay.replace(seed);
    return seed;
  }

  private hasActiveViewer(rec: Record_): boolean {
    return [...rec.subs].some((subscriber) => subscriber.viewing);
  }

  private syncOutputPressure(rec: Record_): void {
    const shouldPause = [...rec.subs].some((sub) => sub.viewing && sub.outputPressured);
    if (shouldPause) rec.proc?.pauseOutput();
    else rec.proc?.resumeOutput();
  }

  private notifyAgentChanged(
    id: string,
    previous: TerminalAgentMeta | undefined,
    current: TerminalAgentMeta | undefined,
  ): void {
    if (
      previous?.provider === current?.provider &&
      previous?.source === current?.source &&
      previous?.identityState === current?.identityState &&
      previous?.providerSessionId === current?.providerSessionId
    ) {
      return;
    }
    try {
      this.deps.onAgentChanged?.(id, previous ? { ...previous } : undefined, current ? { ...current } : undefined);
    } catch {
      /* command-center bookkeeping must never interrupt the terminal */
    }
  }

  private setShellAgent(id: string, rec: ShellRecord, agent: TerminalAgentMeta | undefined): void {
    const previous = rec.meta.agent;
    if (agent) {
      rec.meta.agent = agent;
      rec.meta.provider = agent.provider;
      rec.meta.activity = agent.activity;
      rec.meta.awaiting = agent.activity === "blocked";
      rec.meta.model = agent.model;
      rec.meta.effort = agent.effort;
      rec.meta.identityState = agent.identityState;
      rec.meta.providerSessionId = agent.providerSessionId;
    } else {
      delete rec.meta.agent;
      delete rec.meta.provider;
      delete rec.meta.model;
      delete rec.meta.effort;
      delete rec.meta.identityState;
      delete rec.meta.providerSessionId;
      rec.meta.activity = "idle";
      rec.meta.awaiting = false;
    }
    this.notifyAgentChanged(id, previous, agent);
  }

  /** Late-bound (after listen(), which resolves the loopback port) — same config the chat SessionManager
   *  gets. When set, each terminal's claude is spawned with `--mcp-config` so send_image/send_file work. */
  setAttachConfig(attach: AttachSpawnOptions | undefined): void {
    this.attachConfig = attach;
  }

  create(explicit: CreateTerminalOptions): TerminalMeta {
    if (explicit.options.provider !== explicit.provider) {
      throw new ProviderError("INVALID_PROVIDER_OPTIONS", "provider and options provider must match");
    }
    if (!this.providers.has(explicit.provider)) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${explicit.provider}`);
    }
    const providerAdapter = this.providers.get(explicit.provider);
    if (!this.providers.manifest(explicit.provider).capabilities.launch) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", `provider cannot launch sessions: ${explicit.provider}`);
    }
    if (this.records.has(explicit.id)) {
      throw new Error(`Session id ${explicit.id} already exists`);
    }
    const now = this.deps.now();
    const options = explicit.options;
    const dangerouslySkip =
      options.provider === "claude"
        ? options.dangerouslySkip === true
        : options.provider === "codex"
          ? options.dangerouslyBypassApprovalsAndSandbox === true
          : false;
    const meta: TerminalMeta = {
      id: explicit.id,
      launch: { kind: "managed", provider: explicit.provider },
      agent: {
        provider: explicit.provider,
        source: "managed",
        activity: "idle",
        model: options.model,
        effort:
          options.provider === "claude"
            ? options.effort
            : options.provider === "codex"
              ? options.reasoningEffort
              : undefined,
        ...(options.provider !== "claude" && providerAdapter.resumeIdentity !== "unsupported"
          ? { identityState: "pending" as const }
          : {}),
      },
      provider: explicit.provider,
      cwd: explicit.cwd,
      mode: "terminal",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
      activity: "idle", // the ~2.5s monitor flips it to "working" as soon as claude starts generating
      awaiting: false,
      dangerouslySkip,
      model: options.model,
      effort:
        options.provider === "claude"
          ? options.effort
          : options.provider === "codex"
            ? options.reasoningEffort
            : undefined,
      ...(options.provider === "claude"
        ? { permissionMode: options.permissionMode }
        : options.provider === "codex"
          ? { sandbox: options.sandbox, approvalPolicy: options.approvalPolicy }
          : {}),
      ...(options.provider !== "claude" && providerAdapter.resumeIdentity !== "unsupported"
        ? { identityState: "pending" as const }
        : {}),
    };
    const common: RecordBase = {
      meta,
      cols: clampDim(explicit.cols, 80),
      rows: clampDim(explicit.rows, 24),
      subs: new Set(),
      cleanupPaths: new Set(),
      attachments: [],
      adoptedLive: false,
    };
    if (options.provider === "claude") {
      const claudeOptions = options as ClaudeSessionOptions;
      const spawnArgs = claudeArgsOf(claudeOptions);
      this.deps.store.claimNew({
        provider: "claude",
        launchKind: "managed",
        id: explicit.id,
        cwd: explicit.cwd,
        mode: "terminal",
        dangerouslySkip,
        status: "running",
        createdAt: now,
        lastActivityAt: now,
        ...(spawnArgs.length > 0 ? { spawnArgs } : {}),
      });
      const record: ManagedRecord = {
        ...common,
        kind: "managed",
        provider: "claude",
        options: claudeOptions,
        identityAmbiguous: false,
      };
      this.records.set(explicit.id, record);
    } else if (options.provider === "codex") {
      const codexOptions = options as CodexSessionOptions;
      this.deps.store.claimNew({
        provider: "codex",
        launchKind: "managed",
        id: explicit.id,
        cwd: explicit.cwd,
        mode: "terminal",
        launchOptions: codexOptions,
        status: "running",
        createdAt: now,
        lastActivityAt: now,
      });
      const record: ManagedRecord = {
        ...common,
        kind: "managed",
        provider: "codex",
        options: codexOptions,
        identityAmbiguous: false,
      };
      this.records.set(explicit.id, record);
    } else {
      this.deps.store.claimNew({
        provider: explicit.provider,
        launchKind: "managed",
        externalAdapter: true,
        id: explicit.id,
        cwd: explicit.cwd,
        mode: "terminal",
        launchOptions: options,
        status: "running",
        createdAt: now,
        lastActivityAt: now,
      });
      const record: ManagedRecord = {
        ...common,
        kind: "managed",
        provider: explicit.provider,
        options,
        identityAmbiguous: false,
      };
      this.records.set(explicit.id, record);
    }
    return meta;
  }

  /**
   * Create the product's normal manual Session: a transparent interactive shell in tmux. No coding agent is
   * selected, launched, wrapped, or configured here. The user can run any command; supported agents are observed
   * only while their real foreground process owns the pane.
   */
  createShell(explicit: CreateShellTerminalOptions): TerminalMeta {
    if (this.records.has(explicit.id)) throw new Error(`Session id ${explicit.id} already exists`);
    const now = this.deps.now();
    const shellExecutable = resolveInteractiveShell();
    const meta: TerminalMeta = {
      id: explicit.id,
      launch: { kind: "shell" },
      cwd: explicit.cwd,
      mode: "terminal",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
      activity: "idle",
      awaiting: false,
      dangerouslySkip: false,
    };
    const record: ShellRecord = {
      kind: "shell",
      meta,
      shellExecutable,
      detectionMisses: 0,
      cols: clampDim(explicit.cols, 80),
      rows: clampDim(explicit.rows, 24),
      subs: new Set(),
      cleanupPaths: new Set(),
      attachments: [],
      adoptedLive: false,
    };
    this.deps.store.claimNew({
      launchKind: "shell",
      id: explicit.id,
      cwd: explicit.cwd,
      mode: "terminal",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
    });
    this.records.set(explicit.id, record);
    try {
      this.startShellProcess(explicit.id, record, false);
    } catch (error) {
      this.records.delete(explicit.id);
      this.deps.store.delete(explicit.id);
      throw error;
    }
    return meta;
  }

  /** Temporary explicit-Claude seam for the pre-provider transport. */
  createLegacyClaude(opts: LegacyCreateTerminalOptions): TerminalMeta {
    return this.create({
      id: opts.id,
      cwd: opts.cwd,
      provider: "claude",
      options: parseLegacyClaudeArgs(opts.claudeArgs ?? []),
      ...(opts.cols === undefined ? {} : { cols: opts.cols }),
      ...(opts.rows === undefined ? {} : { rows: opts.rows }),
    });
  }

  /**
   * Delete stale per-session integration files — `mcp-config-<id>.json`, `hooks-<id>.json`, `hook-auth-<id>`,
   * `codex-mcp-token-<id>`, and `codex-hook-<id>-<event>.sh`. A file is stale when no live session owns its id:
   * crash, an orphan-reap, a rehydrated record (which carries no such paths, so stop() never unlinks its files),
   * or a token rotation. Call at boot AFTER rehydrate + setAttachConfig so `records` reflects the surviving
   * sessions. No-op without an attach config.
   */
  sweepStaleMcpConfigs(): number {
    if (!this.attachConfig) return 0;
    const dir = this.attachConfig.dataDir;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    const liveIds = new Set(this.records.keys());
    let removed = 0;
    for (const name of names) {
      const m = /^(?:mcp-config-|hooks-)(.+)\.json$/.exec(name) ?? /^(?:hook-auth-)(.+)$/.exec(name);
      const codexHook = name.startsWith(CODEX_HOOK_SCRIPT_PREFIX)
        ? /^codex-hook-(.+)-(?:start|submit|stop|tool|post-tool|permission)\.sh$/.exec(name)
        : null;
      const sessionId =
        m?.[1] ??
        codexHook?.[1] ??
        (name.startsWith(CODEX_MCP_TOKEN_PREFIX) ? name.slice(CODEX_MCP_TOKEN_PREFIX.length) : undefined);
      if (!sessionId || liveIds.has(sessionId)) continue;
      try {
        unlinkSync(join(dir, name));
        removed += 1;
      } catch {
        /* already gone / race — ignore */
      }
    }
    return removed;
  }

  /**
   * Kill running terminal sessions with NO attached client that have been idle longer than `ttlMs`. OFF by
   * default (ttlMs <= 0) and opt-in via env (SESSION_IDLE_TTL_MS): sessions intentionally survive a
   * disconnect for later reattach, so reaping them must never be the default — it's only for hosts that
   * choose to bound the accumulation of detached claude+tmux processes. Returns the number reaped.
   */
  reapIdle(ttlMs: number): number {
    if (!(ttlMs > 0)) return 0;
    const cutoff = this.deps.now() - ttlMs;
    const stale: string[] = [];
    for (const [id, rec] of this.records) {
      if (rec.subs.size > 0 || rec.meta.status !== "running") continue; // attached or already ended → keep
      if (rec.meta.lastActivityAt <= cutoff) stale.push(id);
    }
    for (const id of stale) this.stop(id); // stop() kills tmux+claude, unlinks the mcp config, prunes the row
    return stale.length;
  }

  /**
   * Push a JSON control message to every attached client of a terminal session. An `attach` (file/image)
   * frame is ALSO buffered (bounded, oldest-dropped) so a client that (re)connects later still sees files
   * that arrived while it was away — see {@link attach}'s replay. Other control frames (e.g. `ask`, which
   * has its own answer/replay flow in the transport) are delivered live only.
   */
  pushControl(id: string, msg: unknown): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    if ((msg as { t?: unknown }).t === "attach") {
      rec.attachments.push(msg);
      if (rec.attachments.length > MAX_ATTACHMENT_BUFFER) rec.attachments.shift();
    }
    const json = JSON.stringify(msg);
    for (const s of [...rec.subs]) {
      try {
        s.onControl?.(json);
      } catch {
        /* ignore a bad sink */
      }
    }
    return true;
  }

  /**
   * Set a session's `awaiting` flag ("claude is blocked on YOU"). The capture-pane monitor
   * ({@link refreshActivity}) is the authority for this flag in production; this explicit setter exists for
   * direct overrides and is exercised by the manager's tests. Deterministic — no timers, no terminal scraping.
   * A missing session is a no-op. Does NOT fire the away-from-desk push — the monitor owns that so it can gate
   * on {@link isAttached}.
   */
  setAwaiting(id: string, value: boolean): void {
    const rec = this.records.get(id);
    if (!rec) return;
    const previous = rec.meta.activity;
    rec.meta.awaiting = value;
    // Keep `activity` consistent for the instant case (the ask flow calls this the moment claude blocks on a
    // question, before the monitor's next sweep): true → "blocked" so the rail shows "needs you" immediately.
    // On false we don't know the real state, so leave `activity` for the monitor to re-derive from the pane.
    if (value) rec.meta.activity = "blocked";
    if (value && rec.meta.agent) rec.meta.agent.activity = "blocked";
    this.notifyActivityChanged(id, previous, rec.meta.activity, rec);
  }

  /**
   * Optional, explicit integration seam for a provider-native hook. It reports identity/state only; it cannot
   * write input, alter argv/PATH/config, or start a process. Foreground process observation remains the baseline.
   */
  reportAgentState(
    id: string,
    state:
      | {
          provider: ProviderId;
          activity: PaneStatus;
          model?: string;
          effort?: string;
          providerSessionId?: string;
        }
      | undefined,
  ): boolean {
    const rec = this.records.get(id);
    if (!rec || rec.kind !== "shell") return false;
    const previousActivity = rec.meta.activity;
    const wasBlocked = rec.meta.awaiting;
    if (!state) {
      this.setShellAgent(id, rec, undefined);
      this.notifyActivityChanged(id, previousActivity, "idle", rec);
      return true;
    }
    try {
      this.providers.get(state.provider);
    } catch {
      return false;
    }
    if (
      !["working", "blocked", "idle"].includes(state.activity) ||
      [state.model, state.effort].some(
        (value) => value !== undefined && (value.length > 256 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)),
      ) ||
      (state.providerSessionId !== undefined &&
        (state.providerSessionId.length === 0 ||
          state.providerSessionId.length > 2048 ||
          /[\p{Cc}\p{Zl}\p{Zp}]/u.test(state.providerSessionId)))
    ) {
      return false;
    }
    rec.detectionMisses = 0;
    this.setShellAgent(id, rec, {
      provider: state.provider,
      source: "integration",
      activity: state.activity,
      ...(state.model ? { model: state.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      ...(state.providerSessionId
        ? { identityState: "exact" as const, providerSessionId: state.providerSessionId }
        : {}),
    });
    this.notifyActivityChanged(id, previousActivity, state.activity, rec);
    if (state.activity === "blocked" && !wasBlocked && !this.hasActiveViewer(rec)) {
      try {
        this.deps.onAwaiting?.(id);
      } catch {
        /* optional notification failure never affects terminal state */
      }
    }
    return true;
  }

  /** Apply a provider-native lifecycle event to the managed session that owns it. Native state remains
   * authoritative until another native event; screen chrome is only the fallback for sessions without it. */
  reportProviderActivity(id: string, provider: ProviderId, activity: PaneStatus): boolean {
    const rec = this.records.get(id);
    if (
      !rec ||
      rec.kind !== "managed" ||
      rec.provider !== provider ||
      rec.meta.status !== "running" ||
      !["working", "blocked", "idle"].includes(activity)
    ) {
      return false;
    }
    this.applyRuntimeSignal(id, rec, { type: activity }, "lifecycle");
    return true;
  }

  /** Clear awaiting and latched provider evidence when the managed process ends or fails. */
  private clearAwaiting(rec: Record_): void {
    rec.meta.awaiting = false;
    if (rec.kind === "managed") {
      rec.runtimeActivity = undefined;
      rec.runtimeActivitySource = undefined;
    }
  }

  /** Whether a session currently has ≥1 attached client (a live browser WS). The hook route uses this so the
   *  away-from-desk push fires ONLY when nobody is watching. */
  isAttached(id: string): boolean {
    return (this.records.get(id)?.subs.size ?? 0) > 0;
  }

  /** How many sessions are currently `awaiting` you. Threaded into each away-from-desk push as `badgeCount`
   *  so the home-screen app badge tracks "how many sessions need you" (Android/desktop badge; iOS can't). */
  awaitingCount(): number {
    let n = 0;
    for (const rec of this.records.values()) if (rec.meta.awaiting) n += 1;
    return n;
  }

  /**
   * Set/clear a session's display name (PATCH /sessions/:id). `undefined` clears back to unnamed. Written
   * through to the store so the name survives restarts + rehydrate. Returns false for an unknown id so the
   * route can 404 without a separate lookup.
   */
  setName(id: string, name: string | undefined): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    rec.meta.name = name;
    this.deps.store.setName(id, name);
    return true;
  }

  /**
   * Re-derive every RUNNING session's `awaiting` flag from its LIVE rendered tmux pane (`capture-pane`). This
   * universal fallback works without hooks, including older and shell-first sessions, while a provider-native
   * needs-input event remains authoritative until an explicit resume event or user input. Both paths work while
   * the browser is detached. Called on a ~2.5s timer from start.ts; capture is read-only.
   *
   * {@link classifyPaneStatus} decides. A capture that returns "" (tmux hiccup) leaves the last value
   * untouched so the status never flaps on a transient miss.
   *
   * `awaiting` (the loud "needs you" flag) tracks activity==="blocked" ONLY — a finished-but-idle session, or
   * one whose background agents are still developing, is NOT "needs you". Fires
   * {@link TerminalManagerDeps.onAwaiting} (the away push) on a not-blocked→blocked transition when no client is
   * foregrounded, so a background PWA connection cannot swallow a genuine blocker alert.
   */
  async refreshActivity(): Promise<void> {
    const capture =
      this.deps.capturePane ??
      ((name: string) => capturePane({ socket: this.deps.tmuxSocket ?? TMUX_SOCKET, sessionName: name }));
    const hasShellSessions = [...this.records.values()].some(
      (record) => record.kind === "shell" && record.meta.status === "running",
    );
    const processSnapshotPromise = hasShellSessions
      ? (
          this.deps.captureForegroundProcesses ??
          (() => captureForegroundProcessSnapshot({ tmuxSocket: this.deps.tmuxSocket ?? TMUX_SOCKET }))
        )()
      : Promise.resolve(undefined);
    // A unit test that supplies its own pane capture stays fully isolated unless it explicitly supplies titles.
    // Production performs one bounded title inventory for every session rather than another tmux process per pane.
    const paneTitlesPromise = this.deps.capturePaneTitles
      ? this.deps.capturePaneTitles()
      : this.deps.capturePane
        ? Promise.resolve(new Map<string, string>())
        : capturePaneTitles({ socket: this.deps.tmuxSocket ?? TMUX_SOCKET });
    const [processSnapshot, paneTitles] = await Promise.all([processSnapshotPromise, paneTitlesPromise]);
    const processDescriptors = this.providers.list().map((provider) => ({
      provider: provider.id,
      aliases: provider.processAliases ?? [provider.id],
    }));
    await Promise.all(
      [...this.records.entries()].map(async ([id, rec]) => {
        if (rec.meta.status !== "running") return;
        const pane = await capture(tmuxSessionName(id));
        if (rec.kind === "shell") {
          // An explicit integration already owns this observational metadata until it sends active:false.
          // Process/pane heuristics must not race an authoritative lifecycle event or make the seam useless for
          // tools whose agent is intentionally hidden behind their own foreground process.
          if (rec.meta.agent?.source === "integration") return;
          if (processSnapshot) {
            const paneProcess = processSnapshot.panes.find(
              (candidate) => candidate.sessionName === tmuxSessionName(id),
            );
            const detected = paneProcess
              ? identifyForegroundAgent(paneProcess.panePid, processSnapshot.processes, processDescriptors)
              : undefined;
            if (detected) {
              rec.detectionMisses = 0;
              if (rec.meta.agent?.provider !== detected.provider || rec.meta.agent.source === "managed") {
                this.setShellAgent(id, rec, {
                  provider: detected.provider,
                  source: rec.meta.agent?.provider === detected.provider ? rec.meta.agent.source : "process",
                  activity: rec.meta.agent?.provider === detected.provider ? rec.meta.agent.activity : "idle",
                });
              }
            } else {
              rec.detectionMisses += 1;
              if (rec.detectionMisses >= 2 && rec.meta.agent) {
                const previousActivity = rec.meta.activity;
                this.setShellAgent(id, rec, undefined);
                this.notifyActivityChanged(id, previousActivity, "idle", rec);
              }
              return;
            }
          } else {
            return; // process inventory failed → preserve identity and activity without flapping
          }
        }
        if (!pane) return; // capture failed/empty → keep the last known value (don't flap on a transient miss)
        const providerId = rec.kind === "managed" ? rec.provider : rec.meta.agent?.provider;
        if (!providerId) return;
        let provider: AgentProvider;
        try {
          provider = this.providers.get(providerId);
        } catch {
          return;
        }
        const title = paneTitles.get(tmuxSessionName(id));
        let classification =
          provider.classifyPaneState?.(pane, { title }) ?? basicPaneClassification(provider.classifyPane(pane));
        if (classification.skipStateUpdate) return;

        // A blank/redrawing frame is not completion evidence. Herdr's production detector confirms only the
        // ambiguous working→plain-idle edge three times at short intervals; reproduce that bounded contract
        // here while explicit prompt/title idle chrome remains immediate.
        if (
          rec.kind === "managed" &&
          rec.runtimeActivity === undefined &&
          rec.meta.activity === "working" &&
          isPlainIdle(classification)
        ) {
          for (let confirmation = 1; confirmation < PLAIN_IDLE_CONFIRMATIONS; confirmation += 1) {
            await recheckDelay();
            const retryPane = await capture(tmuxSessionName(id));
            if (!retryPane) return;
            classification =
              provider.classifyPaneState?.(retryPane, { title }) ??
              basicPaneClassification(provider.classifyPane(retryPane));
            if (classification.skipStateUpdate) return;
            if (!isPlainIdle(classification)) break;
          }
        }
        // CMUX keeps the complete provider lifecycle authoritative, not only `needsInput`: an off-screen pane's
        // old prompt must not erase Running, and an old spinner must not resurrect a completed turn. Live screen
        // evidence remains the fallback for adopted/older sessions that have not emitted a native event.
        const activity =
          rec.kind === "managed" ? (rec.runtimeActivity ?? classification.activity) : classification.activity;
        const runtimeMetadata = provider.runtimeMetadata?.(pane);
        if (runtimeMetadata?.model) rec.meta.model = runtimeMetadata.model;
        if (runtimeMetadata?.effort) rec.meta.effort = runtimeMetadata.effort;
        if (rec.meta.agent) {
          rec.meta.agent.activity = activity;
          if (runtimeMetadata?.model) rec.meta.agent.model = runtimeMetadata.model;
          if (runtimeMetadata?.effort) rec.meta.agent.effort = runtimeMetadata.effort;
        }
        const previous = rec.meta.activity;
        const nowBlocked = activity === "blocked";
        const wasBlocked = rec.meta.awaiting;
        rec.meta.activity = activity;
        rec.meta.awaiting = nowBlocked;
        this.notifyActivityChanged(id, previous, activity, rec);
        if (nowBlocked && !wasBlocked && !this.hasActiveViewer(rec)) {
          try {
            this.deps.onAwaiting?.(id);
          } catch {
            /* a push failure must never break the monitor */
          }
        }
      }),
    );
  }

  private startShellProcess(id: string, rec: ShellRecord, attachOnly: boolean): TerminalProcess {
    const candidate = new TerminalProcess({
      sessionId: id,
      cwd: rec.meta.cwd,
      executable: rec.shellExecutable,
      args: ["-l"],
      env: process.env,
      cols: rec.cols,
      rows: rec.rows,
      ...(this.deps.ptySpawn ? { ptySpawn: this.deps.ptySpawn } : {}),
      ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
      ...(this.deps.readTmuxAlternateScreen ? { readTmuxAlternateScreen: this.deps.readTmuxAlternateScreen } : {}),
      ...(this.deps.readTmuxTerminalState ? { readTmuxTerminalState: this.deps.readTmuxTerminalState } : {}),
      ...(this.deps.readTmuxHistorySeed ? { readTmuxHistorySeed: this.deps.readTmuxHistorySeed } : {}),
      ...(this.deps.tmuxSocket ? { tmuxSocket: this.deps.tmuxSocket } : {}),
      ...(attachOnly ? { attachOnly: true } : {}),
    });
    candidate.on("data", (chunk) => {
      this.fanoutTerminalData(id, rec, chunk);
    });
    candidate.on("exit", () => {
      if (rec.proc !== candidate) return;
      const previousActivity = rec.meta.activity;
      const dying = [...rec.subs];
      const wasViewed = this.hasActiveViewer(rec);
      for (const sink of dying) sink.releaseAbortListener();
      rec.subs.clear();
      this.syncOutputPressure(rec);
      rec.meta.status = "ended";
      rec.proc = undefined;
      rec.detectionMisses = 0;
      this.setShellAgent(id, rec, undefined);
      this.notifyActivityChanged(id, previousActivity, "idle", rec);
      try {
        this.deps.store.setStatus(id, "stopped");
      } catch {
        /* the in-memory terminal state remains truthful */
      }
      for (const sink of dying) {
        try {
          sink.onExit?.();
        } catch {
          /* ignore a bad sink */
        }
      }
      try {
        this.deps.onFinished?.(id, wasViewed);
      } catch {
        /* notifications never own terminal lifecycle */
      }
    });
    try {
      this.prepareTerminalReplay(id, rec, candidate, attachOnly);
      candidate.start();
    } catch (error) {
      candidate.removeAllListeners();
      try {
        candidate.stop({ kill: true });
      } catch {
        /* a partially-started terminal is already fail-closed */
      }
      throw error;
    }
    rec.meta.status = "running";
    rec.proc = candidate;
    rec.adoptedLive = false;
    this.syncOutputPressure(rec);
    return candidate;
  }

  /** Subscribe to provider output, spawning lazily through the owning provider on the first attach. */
  async attach(
    id: string,
    handlers: { onData: (chunk: string) => void; onExit?: () => void; onControl?: (msg: string) => void },
    size?: { cols: number; rows: number },
    opts?: { respawn?: "continue" | "fresh"; signal?: AbortSignal },
  ): Promise<TerminalSub | undefined> {
    const rec = this.records.get(id);
    if (!rec || opts?.signal?.aborted) return undefined;
    const resumeConversation = opts?.respawn === "continue" && rec.meta.status === "ended" && !rec.proc;
    if (
      rec.kind === "managed" &&
      resumeConversation &&
      this.providers.get(rec.provider).resumeIdentity === "required" &&
      (rec.identityAmbiguous || !rec.providerSessionId)
    ) {
      throw new ProviderError(
        "RESUME_IDENTITY_UNAVAILABLE",
        `exact resume identity unavailable for ${rec.provider} session ${id}`,
      );
    }
    if (size) {
      const nextCols = clampDim(size.cols, rec.cols);
      const nextRows = clampDim(size.rows, rec.rows);
      if (nextCols !== rec.cols || nextRows !== rec.rows) {
        rec.cols = nextCols;
        rec.rows = nextRows;
        rec.proc?.resize(nextCols, nextRows);
      }
    }
    let abortListenerAttached = false;
    let detached = false;
    const releaseAbortListener = () => {
      if (!abortListenerAttached) return;
      abortListenerAttached = false;
      opts?.signal?.removeEventListener("abort", abortPendingAttach);
    };
    const sub: TermSub = {
      onData: handlers.onData,
      onExit: handlers.onExit,
      onControl: handlers.onControl,
      releaseAbortListener,
      // Fail open for alerts until the browser sends its foreground state. This prevents a background socket
      // from swallowing a needs-input notification during attach or after an OTA reconnect.
      viewing: false,
      outputPressured: false,
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      releaseAbortListener();
      const wasViewed = this.hasActiveViewer(rec);
      rec.subs.delete(sub);
      this.syncOutputPressure(rec);
      // Keep the owning PTY client while detached: its runtime/exit listeners are the lifecycle monitor for
      // the provider and tmux session. Data fanout is already a no-op with no subscribers, and a later attach
      // reuses this process instead of double-spawning or losing provider cleanup ownership.
      if (wasViewed && !this.hasActiveViewer(rec) && rec.meta.awaiting && rec.meta.status === "running") {
        try {
          this.deps.onAwaiting?.(id);
        } catch {
          /* a push must NEVER break the terminal */
        }
      }
    };
    const abortPendingAttach = () => detach();
    opts?.signal?.addEventListener("abort", abortPendingAttach, { once: true });
    abortListenerAttached = opts?.signal !== undefined;
    rec.subs.add(sub);
    const replay = this.terminalReplaySnapshot(id, rec);
    if (rec.proc && replay) {
      this.deliverTerminalReplay(sub, replay);
    }
    // Replay any file/image attachments that arrived while this client was away, so the Files panel is
    // correct on (re)connect. Only to the newly-attached sub. Each attach frame carries a unique `id`, so
    // the web can dedupe a replayed frame it already rendered. Wrapped so a bad sink can't break attach.
    if (sub.onControl && rec.attachments.length > 0) {
      for (const msg of rec.attachments) {
        try {
          sub.onControl(JSON.stringify(msg));
        } catch {
          /* ignore a bad sink */
        }
      }
    }
    const joinedLiveProcess = rec.proc !== undefined;
    if (!rec.proc) {
      try {
        if (rec.kind === "shell") {
          this.startShellProcess(id, rec, rec.adoptedLive);
        } else {
          const intent = resumeConversation ? "resume" : "fresh";
          if (rec.spawnPromise && rec.spawnIntent !== intent) {
            throw new ProviderError(
              "RESUME_IDENTITY_UNAVAILABLE",
              `conflicting concurrent attach intent for ${rec.provider} session ${id}`,
            );
          }
          if (!rec.spawnPromise) {
            const promise = this.spawnForRecord(id, rec, intent);
            rec.spawnPromise = promise;
            rec.spawnIntent = intent;
            void promise.then(
              () => {
                if (rec.spawnPromise === promise) {
                  rec.spawnPromise = undefined;
                  rec.spawnIntent = undefined;
                }
              },
              () => {
                if (rec.spawnPromise === promise) {
                  rec.spawnPromise = undefined;
                  rec.spawnIntent = undefined;
                }
              },
            );
          }
          await rec.spawnPromise;
        }
      } catch (error) {
        detach();
        throw error;
      }
      if (!rec.proc) {
        detach();
        return undefined;
      }
    }
    if (joinedLiveProcess) {
      // Reattaching to a STILL-RUNNING session: its pty/tmux client is alive from an earlier connection whose
      // WS never cleanly closed (e.g. the app was backgrounded a long time, so the old sub lingered and the pty
      // wasn't torn down + respawned). tmux drew its screen to that pty long ago, so THIS fresh client receives
      // no redraw and shows only a blinking cursor until something changes — the reported "open an old chat →
      // blank until I resize the window" bug. Ask tmux to repaint this exact PTY client.
      //
      // STANDARD TERMINAL-STATE HANDOFF: tmux emitted screen/mouse/cursor/keypad DECSET sequences only when
      // its pty client first attached. A fresh browser must receive the pane's actual protocol state before
      // redraw; process-name guesses cannot work for arbitrary nested terminal applications.
      try {
        sub.onData(rec.proc.terminalStateSeed(rec.kind === "managed" && rec.provider === "claude"));
      } catch {
        /* ignore a bad sink */
      }
      rec.proc.refreshClient();
    }
    return {
      unsubscribe: () => {
        detach();
      },
      setViewing: (viewing: boolean) => {
        if (detached || sub.viewing === viewing) return;
        const wasViewed = this.hasActiveViewer(rec);
        sub.viewing = viewing;
        this.syncOutputPressure(rec);
        const isViewed = this.hasActiveViewer(rec);
        if (!wasViewed && isViewed) {
          try {
            this.deps.onViewed?.(id);
          } catch {
            /* attention bookkeeping must never interrupt a terminal */
          }
        } else if (wasViewed && !isViewed && rec.meta.awaiting && rec.meta.status === "running") {
          try {
            this.deps.onAwaiting?.(id);
          } catch {
            /* background notification failure never interrupts the terminal */
          }
        }
      },
      setOutputPressure: (pressured: boolean) => {
        if (detached || sub.outputPressured === pressured) return;
        sub.outputPressured = pressured;
        this.syncOutputPressure(rec);
      },
    };
  }

  private async spawnForRecord(
    id: string,
    rec: ManagedRecord,
    intent: "fresh" | "resume",
  ): Promise<TerminalProcess | undefined> {
    const provider = this.providers.get(rec.provider);
    const buildingCleanupPaths = new Set<string>();
    try {
      const adoptingLive = rec.adoptedLive && intent === "fresh";
      if (!adoptingLive && !this.providers.has(rec.provider)) {
        throw new ProviderError("PROVIDER_UNAVAILABLE", `provider unavailable: ${rec.provider}`);
      }
      const spec = adoptingLive
        ? { executable: "/usr/bin/true", args: [], env: process.env, cleanupPaths: [] }
        : await provider.buildProcess({
            roamSessionId: id,
            cwd: rec.meta.cwd,
            intent,
            options: rec.options,
            ...(this.attachConfig ? { attach: this.attachConfig } : {}),
            ...(intent === "resume" && rec.providerSessionId ? { providerSessionId: rec.providerSessionId } : {}),
            registerCleanupPaths: (paths) => {
              for (const path of paths) buildingCleanupPaths.add(path);
            },
          });
      for (const path of spec.cleanupPaths) buildingCleanupPaths.add(path);
      if (this.records.get(id) !== rec || rec.subs.size === 0) {
        this.cleanupProviderPaths(provider, [...buildingCleanupPaths]);
        buildingCleanupPaths.clear();
        return undefined;
      }
      for (const path of buildingCleanupPaths) rec.cleanupPaths.add(path);
      buildingCleanupPaths.clear();
      const startProcess = (): TerminalProcess => {
        const candidate = new TerminalProcess({
          sessionId: id,
          cwd: rec.meta.cwd,
          executable: spec.executable,
          args: spec.args,
          env: spec.env,
          cols: rec.cols,
          rows: rec.rows,
          enableMouseHistory: rec.provider === "codex",
          ...(this.deps.ptySpawn ? { ptySpawn: this.deps.ptySpawn } : {}),
          ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
          ...(this.deps.readTmuxAlternateScreen ? { readTmuxAlternateScreen: this.deps.readTmuxAlternateScreen } : {}),
          ...(this.deps.readTmuxTerminalState ? { readTmuxTerminalState: this.deps.readTmuxTerminalState } : {}),
          ...(this.deps.readTmuxHistorySeed ? { readTmuxHistorySeed: this.deps.readTmuxHistorySeed } : {}),
          ...(this.deps.tmuxSocket ? { tmuxSocket: this.deps.tmuxSocket } : {}),
          ...(adoptingLive ? { attachOnly: true } : {}),
        });
        const runtimeSignalParser = provider.createRuntimeSignalParser?.();
        candidate.on("data", (chunk) => {
          try {
            const signals = runtimeSignalParser ? runtimeSignalParser.push(chunk) : provider.runtimeSignals(chunk);
            for (const signal of signals) this.applyRuntimeSignal(id, rec, signal);
          } catch {
            /* malformed provider output must not interrupt PTY fanout */
          }
          this.fanoutTerminalData(id, rec, chunk);
        });
        candidate.on("exit", () => {
          if (rec.proc !== candidate) return;
          const previousActivity = rec.meta.activity;
          const dying = [...rec.subs];
          const wasViewed = this.hasActiveViewer(rec);
          for (const sink of dying) sink.releaseAbortListener();
          rec.subs.clear();
          this.syncOutputPressure(rec);
          rec.meta.status = "ended";
          rec.meta.activity = "idle";
          if (rec.meta.agent) rec.meta.agent.activity = "idle";
          this.clearAwaiting(rec);
          this.notifyActivityChanged(id, previousActivity, "idle", rec);
          rec.proc = undefined;
          this.cleanupRecordPaths(rec, provider);
          for (const sink of dying) {
            try {
              sink.onExit?.();
            } catch {
              /* ignore */
            }
          }
          try {
            this.deps.onFinished?.(id, wasViewed);
          } catch {
            /* ignore */
          }
        });
        try {
          this.prepareTerminalReplay(id, rec, candidate, adoptingLive);
          candidate.start();
        } catch (error) {
          candidate.removeAllListeners();
          try {
            candidate.stop({ kill: true });
          } catch {
            /* a partially-started terminal is already fail-closed */
          }
          throw error;
        }
        // Publish only after the actual PTY/tmux client started successfully. A failed start must never leave
        // a broken object that makes attach believe a terminal exists.
        rec.meta.status = "running";
        rec.proc = candidate;
        rec.adoptedLive = false;
        this.syncOutputPressure(rec);
        return candidate;
      };

      if (adoptingLive) return startProcess();

      if (rec.provider !== "claude" && provider.resumeIdentity !== "unsupported" && intent === "fresh") {
        const storedIdentity = this.deps.store.get(id)?.providerSessionId;
        if (rec.providerSessionId !== undefined || storedIdentity !== undefined) {
          // A deliberate fresh restart creates a new conversation. Retire the old authoritative id before
          // the resolver snapshot/spawn so provisional ownership can never collide with, resume, or expose
          // the previous thread. Persist first: a crash after this point remains fail-closed on reopen.
          this.deps.store.setProviderSessionId(id, undefined);
          rec.providerSessionId = undefined;
          rec.meta.providerSessionId = undefined;
          if (rec.meta.agent) rec.meta.agent.providerSessionId = undefined;
        }
        rec.identityAmbiguous = false;
        rec.meta.identityState = "pending";
        if (rec.meta.agent) rec.meta.agent.identityState = "pending";
      }

      if (rec.provider === "codex" && intent === "fresh" && this.deps.codexThreadResolver) {
        let proc: TerminalProcess | undefined;
        let terminalSpawnAttempted = false;
        let terminalSpawnError: unknown;
        let preSpawnError: unknown;
        try {
          const exactId = await this.deps.codexThreadResolver(rec.meta.cwd).resolveAfterSpawn({
            cwd: rec.meta.cwd,
            persistence: createCodexThreadPersistence(this.deps.store, id),
            spawn: (signal) => {
              const started = (async () => {
                try {
                  await spec.preSpawnCheck?.();
                } catch (error) {
                  preSpawnError = error;
                  throw error;
                }
                if (signal.aborted || this.records.get(id) !== rec || rec.subs.size === 0) {
                  throw new ProviderError("RESUME_IDENTITY_UNAVAILABLE", "Codex launch was canceled");
                }
                terminalSpawnAttempted = true;
                try {
                  proc = startProcess();
                } catch (error) {
                  terminalSpawnError = error;
                  throw error;
                }
              })();
              return {
                started,
                cancel: async () => {
                  try {
                    await started;
                  } catch {
                    return; // no process exists, so cancellation is fully acknowledged
                  }
                  // A live terminal is deliberately not killed for auxiliary identity failure. An unresolved
                  // acknowledgement makes the Task 7 coordinator poison later discovery before releasing.
                  await new Promise<void>(() => {});
                },
              };
            },
          });
          rec.providerSessionId = exactId;
          rec.identityAmbiguous = false;
          rec.meta.providerSessionId = exactId;
          rec.meta.identityState = "exact";
          if (rec.meta.agent) {
            rec.meta.agent.providerSessionId = exactId;
            rec.meta.agent.identityState = "exact";
          }
          return proc;
        } catch {
          if (terminalSpawnError !== undefined) throw terminalSpawnError;
          if (preSpawnError !== undefined) throw preSpawnError;
          rec.providerSessionId = undefined;
          rec.identityAmbiguous = true;
          rec.meta.providerSessionId = undefined;
          rec.meta.identityState = "ambiguous";
          if (rec.meta.agent) {
            rec.meta.agent.providerSessionId = undefined;
            rec.meta.agent.identityState = "ambiguous";
          }
          try {
            this.deps.store.setProviderSessionId(id, undefined);
          } catch {
            /* identity remains fail-closed in memory */
          }
          if (!proc && !terminalSpawnAttempted && this.records.get(id) === rec && rec.subs.size > 0) {
            // Discovery failed before a terminal was actually attempted (including a resolver-owned deadline
            // between proof and spawn). Starting now is intentionally untracked, so poison process-wide
            // discovery, recheck any selected-profile proof immediately before the fallback process
            // construction, then allow this degraded-but-usable terminal to continue.
            codexThreadResolutionCoordinator.poisonUnknownSpawnOutcome();
            await spec.preSpawnCheck?.();
            if (this.records.get(id) !== rec) return undefined;
            if (rec.subs.size > 0) {
              terminalSpawnAttempted = true;
              proc = startProcess();
            }
          }
          if (!proc) {
            rec.meta.status = "ended";
            rec.meta.activity = "idle";
            if (rec.meta.agent) rec.meta.agent.activity = "idle";
            this.clearAwaiting(rec);
            try {
              this.deps.store.setStatus(id, "dormant");
            } catch {
              /* in-memory state is still truthfully ended */
            }
            this.cleanupRecordPaths(rec, provider);
          }
          return proc;
        }
      }

      await spec.preSpawnCheck?.();
      if (this.records.get(id) !== rec || rec.subs.size === 0) {
        this.cleanupRecordPaths(rec, provider);
        return undefined;
      }
      return startProcess();
    } catch (error) {
      rec.proc = undefined;
      rec.meta.status = "ended";
      rec.meta.activity = "idle";
      if (rec.meta.agent) rec.meta.agent.activity = "idle";
      this.clearAwaiting(rec);
      try {
        this.deps.store.setStatus(id, "errored");
      } catch {
        /* preserve the original provider/terminal error */
      }
      this.cleanupProviderPaths(provider, [...buildingCleanupPaths]);
      buildingCleanupPaths.clear();
      this.cleanupRecordPaths(rec, provider);
      throw error;
    }
  }

  private cleanupProviderPaths(provider: AgentProvider, paths: readonly string[]): void {
    if (paths.length === 0) return;
    try {
      provider.cleanup(paths);
    } catch {
      /* provider cleanup is best-effort and must not break teardown */
    }
  }

  private cleanupRecordPaths(rec: ManagedRecord, provider: AgentProvider): void {
    if (rec.cleanupPaths.size === 0) return;
    const paths = [...rec.cleanupPaths];
    rec.cleanupPaths.clear();
    this.cleanupProviderPaths(provider, paths);
  }

  private applyRuntimeSignal(
    id: string,
    rec: ManagedRecord,
    signal: ProviderRuntimeSignal,
    source: "lifecycle" | "runtime" = "runtime",
  ): void {
    if (signal.type === "provider-session-id") {
      if (this.providers.manifest(rec.provider).resumeIdentity === "unsupported") return;
      // Production exact identity is resolver-owned. OSC ids remain a compatibility signal only when no
      // resolver was configured (principally isolated adapter/manager tests).
      if (rec.provider === "codex" && this.deps.codexThreadResolver) return;
      if (rec.identityAmbiguous || (rec.providerSessionId && rec.providerSessionId !== signal.id)) {
        rec.identityAmbiguous = true;
        rec.providerSessionId = undefined;
        rec.meta.identityState = "ambiguous";
        rec.meta.providerSessionId = undefined;
        if (rec.meta.agent) {
          rec.meta.agent.identityState = "ambiguous";
          rec.meta.agent.providerSessionId = undefined;
        }
        this.deps.store.setProviderSessionId(id, undefined);
        return;
      }
      try {
        this.deps.store.setProviderSessionId(id, signal.id);
        rec.providerSessionId = signal.id;
        rec.meta.identityState = "exact";
        rec.meta.providerSessionId = signal.id;
        if (rec.meta.agent) {
          rec.meta.agent.identityState = "exact";
          rec.meta.agent.providerSessionId = signal.id;
        }
      } catch {
        rec.identityAmbiguous = true;
        rec.providerSessionId = undefined;
        rec.meta.identityState = "ambiguous";
        rec.meta.providerSessionId = undefined;
        if (rec.meta.agent) {
          rec.meta.agent.identityState = "ambiguous";
          rec.meta.agent.providerSessionId = undefined;
        }
        try {
          this.deps.store.setProviderSessionId(id, undefined);
        } catch {
          /* already fail-closed in memory */
        }
      }
      return;
    }
    const previous = rec.meta.activity;
    const wasBlocked = rec.meta.awaiting;
    rec.runtimeActivity = signal.type;
    rec.runtimeActivitySource = source;
    rec.meta.activity = signal.type;
    if (rec.meta.agent) rec.meta.agent.activity = signal.type;
    rec.meta.awaiting = signal.type === "blocked";
    this.notifyActivityChanged(id, previous, signal.type, rec);
    if (rec.meta.awaiting && !wasBlocked && !this.hasActiveViewer(rec)) {
      try {
        this.deps.onAwaiting?.(id);
      } catch {
        /* a push failure must not break terminal output */
      }
    }
  }

  write(id: string, data: string): void {
    const rec = this.records.get(id);
    rec?.proc?.write(data);
    if (rec) {
      if (rec.kind === "managed" || rec.meta.agent) {
        const previous = rec.meta.activity;
        let activity: PaneStatus = "working";
        if (rec.kind === "managed" && rec.runtimeActivity !== undefined) {
          // Draft text and navigation do not resume an agent that its own lifecycle still calls idle/blocked.
          // A bare Enter is a narrow fallback for an OSC-only blocker or a new idle prompt. A lifecycle-hook
          // blocker stays authoritative until a follow-up lifecycle event proves that the provider resumed.
          if (data === "\r" && !(rec.runtimeActivity === "blocked" && rec.runtimeActivitySource === "lifecycle")) {
            rec.runtimeActivity = "working";
            rec.runtimeActivitySource = "input";
          }
          activity = rec.runtimeActivity;
        }
        rec.meta.activity = activity;
        if (rec.meta.agent) rec.meta.agent.activity = activity;
        rec.meta.awaiting = activity === "blocked";
        this.notifyActivityChanged(id, previous, activity, rec);
      }
      rec.meta.lastActivityAt = this.deps.now();
      this.deps.store.touch(id, rec.meta.lastActivityAt);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const rec = this.records.get(id);
    if (!rec) return;
    const nextCols = clampDim(cols, rec.cols);
    const nextRows = clampDim(rows, rec.rows);
    if (nextCols === rec.cols && nextRows === rec.rows) return;
    rec.cols = nextCols;
    rec.rows = nextRows;
    rec.proc?.resize(nextCols, nextRows);
  }

  stop(id: string): void {
    const rec = this.records.get(id);
    this.records.delete(id);
    this.terminalReplay.delete(id);
    if (rec?.proc) {
      for (const sub of rec.subs) sub.outputPressured = false;
      this.syncOutputPressure(rec);
      const proc = rec.proc;
      rec.proc = undefined;
      proc.removeAllListeners();
      proc.stop({ kill: true });
    } else this.killTmux(id);
    if (rec?.kind === "managed") {
      this.cleanupRecordPaths(rec, this.providers.get(rec.provider));
    }
    this.deps.store.delete(id);
  }

  get(id: string): TerminalMeta | undefined {
    return this.records.get(id)?.meta;
  }

  list(): TerminalMeta[] {
    return [...this.records.values()].map((r) => r.meta);
  }

  /**
   * After a server/OTA restart: adopt stored terminal sessions whose tmux session is still alive (so they
   * reappear, resumable), prune store rows whose tmux session is gone, AND kill ORPHAN tmux sessions — live
   * `rc-*` sessions with no store row (leaked by a crash or an interrupted cleanup) — so they don't pile up.
   */
  rehydrate(opts: { liveTmuxNames: string[] }): void {
    const live = new Set(opts.liveTmuxNames);
    const storedTerminalIds = new Set(
      this.deps.store
        .list()
        .filter((s) => s.mode === "terminal")
        .map((s) => s.id),
    );
    for (const s of this.deps.store.list()) {
      if (s.mode !== "terminal") continue;
      if (!live.has(tmuxSessionName(s.id))) {
        this.deps.store.delete(s.id); // tmux session gone → prune the stale row
        continue;
      }
      if (this.records.has(s.id)) continue;
      if (isStoredShellSession(s)) {
        let shellExecutable: string;
        try {
          shellExecutable = resolveInteractiveShell();
        } catch {
          continue; // retain the row and live tmux Session; a later healthy boot can adopt it
        }
        this.records.set(s.id, {
          kind: "shell",
          shellExecutable,
          detectionMisses: 0,
          meta: {
            id: s.id,
            launch: { kind: "shell" },
            cwd: s.cwd,
            mode: "terminal",
            status: "running",
            createdAt: s.createdAt,
            lastActivityAt: s.lastActivityAt,
            activity: "idle",
            awaiting: false,
            dangerouslySkip: false,
            ...(s.name ? { name: s.name } : {}),
          },
          cols: 80,
          rows: 24,
          subs: new Set(),
          cleanupPaths: new Set(),
          attachments: [],
          adoptedLive: true,
        });
        continue;
      }
      let providerAdapter: AgentProvider;
      try {
        providerAdapter = this.providers.get(s.provider);
      } catch {
        continue; // retain the durable row and live tmux session; never launch under another provider
      }
      let parsedOptions: ProviderSessionOptions;
      try {
        parsedOptions =
          s.externalAdapter === true
            ? s.launchOptions
            : s.provider === "claude"
              ? parseLegacyClaudeArgs(s.spawnArgs ?? [])
              : s.launchOptions;
      } catch {
        continue; // isolate malformed historical options to this row; retain it for diagnostics
      }
      const options: ProviderSessionOptions =
        s.externalAdapter !== true &&
        s.provider === "claude" &&
        parsedOptions.provider === "claude" &&
        s.dangerouslySkip
          ? { ...parsedOptions, dangerouslySkip: true }
          : parsedOptions;
      const common: RecordBase = {
        meta: {
          id: s.id,
          launch: {
            kind: "managed",
            provider: s.provider,
          },
          agent: {
            provider: s.provider,
            source: "managed",
            activity: "idle",
            model: options.model,
            effort:
              options.provider === "claude"
                ? options.effort
                : options.provider === "codex"
                  ? options.reasoningEffort
                  : undefined,
            ...(s.provider !== "claude" && providerAdapter.resumeIdentity !== "unsupported"
              ? s.providerSessionId
                ? {
                    identityState: "exact" as const,
                    providerSessionId: s.providerSessionId,
                  }
                : { identityState: "ambiguous" as const }
              : {}),
          },
          provider: s.provider,
          cwd: s.cwd,
          mode: "terminal",
          status: "running",
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
          activity: "idle", // the monitor re-derives real activity from the pane on its next ~2.5s sweep
          awaiting: false,
          // Preserve the persisted RCE-skip flag so a rehydrated session is still badged correctly.
          dangerouslySkip:
            options.provider === "claude"
              ? options.dangerouslySkip === true
              : options.provider === "codex"
                ? options.dangerouslyBypassApprovalsAndSandbox === true
                : false,
          model: options.model,
          effort:
            options.provider === "claude"
              ? options.effort
              : options.provider === "codex"
                ? options.reasoningEffort
                : undefined,
          ...(options.provider === "claude"
            ? { permissionMode: options.permissionMode }
            : options.provider === "codex"
              ? { sandbox: options.sandbox, approvalPolicy: options.approvalPolicy }
              : {}),
          // The user's rename survives a server restart the same way.
          name: s.name,
          ...(s.provider !== "claude" && providerAdapter.resumeIdentity !== "unsupported"
            ? s.providerSessionId
              ? { identityState: "exact" as const, providerSessionId: s.providerSessionId }
              : { identityState: "ambiguous" as const }
            : {}),
        },
        cols: 80,
        rows: 24,
        subs: new Set(),
        cleanupPaths: new Set(),
        attachments: [],
        adoptedLive: true,
      };
      if (options.provider !== s.provider) continue;
      this.records.set(s.id, {
        ...common,
        kind: "managed",
        provider: s.provider,
        options,
        ...(s.provider !== "claude" && s.providerSessionId ? { providerSessionId: s.providerSessionId } : {}),
        identityAmbiguous: false,
      });
    }
    // Orphan-reap ONLY with a durable store. In "memory-fallback" (better-sqlite3 didn't load) the store is
    // EMPTY after a restart, so EVERY live rc-* session looks like an orphan — reaping would then destroy
    // ALL running terminals on any restart (incl. OTA), e.g. after a native-module ABI break. Leaking a
    // genuinely-orphaned tmux session is far better than killing every live one, so skip reaping here.
    if (this.deps.store.mode !== "memory-fallback") {
      for (const name of opts.liveTmuxNames) {
        if (!name.startsWith("rc-")) continue;
        const id = name.slice(3);
        if (!storedTerminalIds.has(id)) this.killTmux(id); // orphan → reap
      }
    }
  }

  /** Kill a tmux session for an id without needing a live proc (reuses TerminalProcess's socketed kill). */
  private killTmux(id: string): void {
    new TerminalProcess({
      sessionId: id,
      cwd: "/",
      executable: "/usr/bin/true",
      ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
      ...(this.deps.tmuxSocket ? { tmuxSocket: this.deps.tmuxSocket } : {}),
    }).stop({ kill: true });
  }
}
