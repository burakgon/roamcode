// packages/server/src/terminal-manager.ts
import { unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TerminalProcess, tmuxSessionName, TMUX_SOCKET, type PtySpawn } from "./terminal-process.js";
import { capturePane, type PaneStatus } from "./pane-status.js";
import { CODEX_MCP_TOKEN_PREFIX, type AttachSpawnOptions } from "./config.js";
import type { SessionStore } from "./session-store.js";
import { parseLegacyClaudeArgs } from "./providers/options.js";
import { ProviderRegistry } from "./providers/registry.js";
import {
  ProviderError,
  type AgentProvider,
  type ClaudeSessionOptions,
  type CodexSessionOptions,
  type ProviderId,
  type ProviderRuntimeSignal,
  type ProviderSessionOptions,
} from "./providers/types.js";
import { createCodexThreadPersistence } from "./providers/codex-thread-persistence.js";
import { codexThreadResolutionCoordinator } from "./providers/codex-thread-coordinator.js";
import type { CodexThreadResolver } from "./providers/codex-thread-resolver.js";

export interface TerminalMeta {
  id: string;
  provider: ProviderId;
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
}

/** A single attached client: its output sink, an optional exit notifier, and an optional out-of-band
 *  CONTROL channel (JSON strings) used to push file/image attachments to the client. */
interface TermSub {
  onData: (chunk: string) => void;
  onExit?: () => void;
  onControl?: (msg: string) => void;
  releaseAbortListener: () => void;
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
}

type Record_ =
  | (RecordBase & {
      provider: "claude";
      options: ClaudeSessionOptions;
      providerSessionId?: never;
      identityAmbiguous?: never;
    })
  | (RecordBase & {
      provider: "codex";
      options: CodexSessionOptions;
      providerSessionId?: string;
      identityAmbiguous: boolean;
    });

export interface TerminalManagerDeps {
  store: SessionStore;
  providers: ProviderRegistry;
  now: () => number;
  ptySpawn?: PtySpawn;
  runTmux?: (args: string[]) => void;
  /** Dedicated tmux server socket. Defaults to the unchanged production socket; integration tests inject a
   * unique socket so spawn, capture, resume, and cleanup cannot touch a live RoamCode instance. */
  tmuxSocket?: string;
  /**
   * Best-effort notifier fired on a false→true `awaiting` transition WHEN NO CLIENT IS ATTACHED (i.e. the
   * user is away from the desk). Wired by the transport to the push dispatcher; omitted in tests. Called in
   * a try/catch — a throw here can NEVER break the terminal.
   */
  onAwaiting?: (id: string) => void;
  /**
   * Best-effort notifier fired when a session's claude exits (the "done" ping). `wasAttached` reports whether
   * a client was still attached at the moment of exit — captured BEFORE the subs are torn down — so the
   * transport can gate the away-from-desk push on "nobody was watching" (you already see the WS close when you
   * are). Same never-throw contract.
   */
  onFinished?: (id: string, wasAttached: boolean) => void;
  /**
   * Capture a tmux session's CURRENT rendered pane as plain text (READ-ONLY). Injected for tests; in
   * production it defaults to a real `capture-pane -p` on {@link TMUX_SOCKET}. Drives {@link refreshActivity},
   * the universal (hook-free) working-vs-awaiting classifier.
   */
  capturePane?: (sessionName: string) => Promise<string>;
  /** Builds the cwd-scoped exact-thread resolver used around a fresh Codex TUI spawn. */
  codexThreadResolver?: (cwd: string) => CodexThreadResolver;
}

/** Cap the per-session replay buffer of attachment frames so a long-lived session can't grow unbounded. */
const MAX_ATTACHMENT_BUFFER = 50;

const clampDim = (n: number | undefined, fallback: number): number =>
  Math.max(1, Math.trunc(n ?? fallback) || fallback);

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

type CreateTerminalOptions =
  | { id: string; cwd: string; provider: "claude"; options: ClaudeSessionOptions; cols?: number; rows?: number }
  | { id: string; cwd: string; provider: "codex"; options: CodexSessionOptions; cols?: number; rows?: number };

type LegacyCreateTerminalOptions = {
  id: string;
  cwd: string;
  claudeArgs?: string[];
  cols?: number;
  rows?: number;
};

export class TerminalManager {
  private readonly records = new Map<string, Record_>();
  private readonly providers: ProviderRegistry;
  private attachConfig?: AttachSpawnOptions;
  constructor(private readonly deps: TerminalManagerDeps) {
    this.providers = deps.providers;
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
    this.providers.get(explicit.provider);
    if (this.records.has(explicit.id)) {
      throw new Error(`Session id ${explicit.id} already exists`);
    }
    const now = this.deps.now();
    const options = explicit.options;
    const dangerouslySkip =
      options.provider === "claude"
        ? options.dangerouslySkip === true
        : options.dangerouslyBypassApprovalsAndSandbox === true;
    const meta: TerminalMeta = {
      id: explicit.id,
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
      effort: options.provider === "claude" ? options.effort : options.reasoningEffort,
      ...(options.provider === "claude"
        ? { permissionMode: options.permissionMode }
        : { sandbox: options.sandbox, approvalPolicy: options.approvalPolicy }),
      ...(options.provider === "codex" ? { identityState: "pending" as const } : {}),
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
      const spawnArgs = claudeArgsOf(options);
      this.deps.store.claimNew({
        provider: "claude",
        id: explicit.id,
        cwd: explicit.cwd,
        mode: "terminal",
        dangerouslySkip,
        status: "running",
        createdAt: now,
        lastActivityAt: now,
        ...(spawnArgs.length > 0 ? { spawnArgs } : {}),
      });
      const record: Record_ = { ...common, provider: "claude", options };
      this.records.set(explicit.id, record);
    } else {
      this.deps.store.claimNew({
        provider: "codex",
        id: explicit.id,
        cwd: explicit.cwd,
        mode: "terminal",
        launchOptions: options,
        status: "running",
        createdAt: now,
        lastActivityAt: now,
      });
      const record: Record_ = { ...common, provider: "codex", options, identityAmbiguous: false };
      this.records.set(explicit.id, record);
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
   * Delete stale per-session 0600 files that hold the access token — `mcp-config-<id>.json`, `hooks-<id>.json`,
   * `hook-auth-<id>`, and `codex-mcp-token-<id>`. A file is stale when no live session owns its id: leaked by a
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
      const sessionId =
        m?.[1] ?? (name.startsWith(CODEX_MCP_TOKEN_PREFIX) ? name.slice(CODEX_MCP_TOKEN_PREFIX.length) : undefined);
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
    rec.meta.awaiting = value;
    // Keep `activity` consistent for the instant case (the ask flow calls this the moment claude blocks on a
    // question, before the monitor's next sweep): true → "blocked" so the rail shows "needs you" immediately.
    // On false we don't know the real state, so leave `activity` for the monitor to re-derive from the pane.
    if (value) rec.meta.activity = "blocked";
  }

  /** Clear the awaiting flag (user is active / session ended). */
  private clearAwaiting(rec: Record_): void {
    rec.meta.awaiting = false;
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
   * Re-derive every RUNNING session's `awaiting` flag from its LIVE rendered tmux pane (`capture-pane`) — the
   * single, UNIVERSAL source of truth for working / blocked / idle. Works for EVERY session (no per-session
   * hooks needed → correct for sessions created before hooks existed) and works while the browser is DETACHED
   * (it reads tmux directly). Called on a ~2.5s timer from start.ts. Read-only: it can never disturb a live
   * session.
   *
   * {@link classifyPaneStatus} decides. A capture that returns "" (tmux hiccup) leaves the last value
   * untouched so the status never flaps on a transient miss.
   *
   * `awaiting` (the loud "needs you" flag) tracks activity==="blocked" ONLY — a finished-but-idle session, or
   * one whose background agents are still developing, is NOT "needs you". Fires
   * {@link TerminalManagerDeps.onAwaiting} (the away push) on a not-blocked→blocked transition when no client is
   * attached, so the nudge is universal + fires only for a genuine block.
   */
  async refreshActivity(): Promise<void> {
    const capture =
      this.deps.capturePane ??
      ((name: string) => capturePane({ socket: this.deps.tmuxSocket ?? TMUX_SOCKET, sessionName: name }));
    await Promise.all(
      [...this.records.entries()].map(async ([id, rec]) => {
        if (rec.meta.status !== "running") return;
        const pane = await capture(tmuxSessionName(id));
        if (!pane) return; // capture failed/empty → keep the last known value (don't flap on a transient miss)
        const provider = this.providers.get(rec.provider);
        const activity = provider.classifyPane(pane);
        const runtimeMetadata = provider.runtimeMetadata?.(pane);
        if (runtimeMetadata?.model) rec.meta.model = runtimeMetadata.model;
        if (runtimeMetadata?.effort) rec.meta.effort = runtimeMetadata.effort;
        const nowBlocked = activity === "blocked";
        const wasBlocked = rec.meta.awaiting;
        rec.meta.activity = activity;
        rec.meta.awaiting = nowBlocked;
        if (nowBlocked && !wasBlocked && rec.subs.size === 0) {
          try {
            this.deps.onAwaiting?.(id);
          } catch {
            /* a push failure must never break the monitor */
          }
        }
      }),
    );
  }

  /**
   * Nudge tmux to repaint the WHOLE screen for a session whose pty is already running — used when a client
   * REATTACHES (a fresh xterm) to a still-live tmux client that drew its screen earlier and won't redraw on
   * its own, so the new client would otherwise show only a blinking cursor until something changes. A brief
   * pty size wiggle (+1 row, then back) sends SIGWINCH, which makes tmux redraw — exactly what the manual
   * window-resize the user found does, minus the manual part. Deferred so the new client's own initial resize
   * lands first (rec.cols/rec.rows are then the final size we wiggle around). Best-effort + unref'd timers.
   */
  private forceRedraw(rec: Record_): void {
    const proc = rec.proc;
    if (!proc) return;
    const t = setTimeout(() => {
      if (rec.proc !== proc) return; // detached / respawned in the meantime
      proc.resize(rec.cols, Math.max(1, rec.rows + 1)); // wiggle up → SIGWINCH → tmux redraws
      const back = setTimeout(() => {
        if (rec.proc === proc) proc.resize(rec.cols, rec.rows); // ...then restore the real viewport size
      }, 60);
      if (typeof back.unref === "function") back.unref();
    }, 180);
    if (typeof t.unref === "function") t.unref();
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
    const provider = this.providers.get(rec.provider);
    if (
      resumeConversation &&
      provider.resumeIdentity === "required" &&
      (rec.provider !== "codex" || rec.identityAmbiguous || !rec.providerSessionId)
    ) {
      throw new ProviderError(
        "RESUME_IDENTITY_UNAVAILABLE",
        `exact resume identity unavailable for ${rec.provider} session ${id}`,
      );
    }
    if (size && !rec.proc) {
      rec.cols = clampDim(size.cols, rec.cols);
      rec.rows = clampDim(size.rows, rec.rows);
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
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      releaseAbortListener();
      rec.subs.delete(sub);
      // Keep the owning PTY client while detached: its runtime/exit listeners are the lifecycle monitor for
      // the provider and tmux session. Data fanout is already a no-op with no subscribers, and a later attach
      // reuses this process instead of double-spawning or losing provider cleanup ownership.
      if (rec.subs.size === 0 && rec.meta.awaiting && rec.meta.status === "running") {
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
      // wasn't torn down + respawned). tmux drew its screen to that pty long ago, so THIS fresh xterm receives
      // no redraw and shows only a blinking cursor until something changes — the reported "open an old chat →
      // blank until I resize the window" bug. Nudge tmux to repaint the whole screen. See forceRedraw.
      //
      // ALT-SCREEN HANDOFF: a tmux client sits on the ALTERNATE screen for its whole attached life, but it
      // sent that enter sequence (`smcup`, \x1b[?1049h) only ONCE — down the pty when it first attached, to a
      // subscriber that's long gone. A fresh xterm joining this LIVE pty therefore renders the coming redraw
      // into its NORMAL buffer: every repaint stacks into local scrollback (a phantom right-hand scrollbar),
      // and the web client's two-finger gesture — which picks claude's pager vs local scrollback by the
      // active buffer type — silently degrades to scrolling that junk buffer (user report: "sağda scrollbar
      // çıkıyor, arkaya çok az kaydırabiliyorum"). Flip the newcomer onto the alt screen BEFORE the redraw.
      try {
        sub.onData("\x1b[?1049h");
      } catch {
        /* ignore a bad sink */
      }
      this.forceRedraw(rec);
    }
    return {
      unsubscribe: () => {
        detach();
      },
    };
  }

  private async spawnForRecord(
    id: string,
    rec: Record_,
    intent: "fresh" | "resume",
  ): Promise<TerminalProcess | undefined> {
    const provider = this.providers.get(rec.provider);
    const buildingCleanupPaths = new Set<string>();
    try {
      const adoptingLive = rec.adoptedLive && intent === "fresh";
      const spec = adoptingLive
        ? { executable: "/usr/bin/true", args: [], env: process.env, cleanupPaths: [] }
        : await provider.buildProcess({
            roamSessionId: id,
            cwd: rec.meta.cwd,
            intent,
            options: rec.options,
            ...(this.attachConfig ? { attach: this.attachConfig } : {}),
            ...(intent === "resume" && rec.provider === "codex" && rec.providerSessionId
              ? { providerSessionId: rec.providerSessionId }
              : {}),
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
          ...(this.deps.ptySpawn ? { ptySpawn: this.deps.ptySpawn } : {}),
          ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
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
          for (const sink of [...rec.subs]) {
            try {
              sink.onData(chunk);
            } catch {
              /* ignore a bad sink */
            }
          }
        });
        candidate.on("exit", () => {
          if (rec.proc !== candidate) return;
          rec.meta.status = "ended";
          rec.meta.activity = "idle";
          this.clearAwaiting(rec);
          rec.proc = undefined;
          this.cleanupRecordPaths(rec, provider);
          const dying = [...rec.subs];
          const wasAttached = dying.length > 0;
          for (const sink of dying) sink.releaseAbortListener();
          rec.subs.clear();
          for (const sink of dying) {
            try {
              sink.onExit?.();
            } catch {
              /* ignore */
            }
          }
          try {
            this.deps.onFinished?.(id, wasAttached);
          } catch {
            /* ignore */
          }
        });
        try {
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
        return candidate;
      };

      if (adoptingLive) return startProcess();

      if (rec.provider === "codex" && intent === "fresh") {
        const storedIdentity = this.deps.store.get(id)?.providerSessionId;
        if (rec.providerSessionId !== undefined || storedIdentity !== undefined) {
          // A deliberate fresh restart creates a new conversation. Retire the old authoritative id before
          // the resolver snapshot/spawn so provisional ownership can never collide with, resume, or expose
          // the previous thread. Persist first: a crash after this point remains fail-closed on reopen.
          this.deps.store.setProviderSessionId(id, undefined);
          rec.providerSessionId = undefined;
          rec.meta.providerSessionId = undefined;
        }
        rec.identityAmbiguous = false;
        rec.meta.identityState = "pending";
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
          return proc;
        } catch {
          if (terminalSpawnError !== undefined) throw terminalSpawnError;
          if (preSpawnError !== undefined) throw preSpawnError;
          rec.providerSessionId = undefined;
          rec.identityAmbiguous = true;
          rec.meta.providerSessionId = undefined;
          rec.meta.identityState = "ambiguous";
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

  private cleanupRecordPaths(rec: Record_, provider: AgentProvider): void {
    if (rec.cleanupPaths.size === 0) return;
    const paths = [...rec.cleanupPaths];
    rec.cleanupPaths.clear();
    this.cleanupProviderPaths(provider, paths);
  }

  private applyRuntimeSignal(id: string, rec: Record_, signal: ProviderRuntimeSignal): void {
    if (signal.type === "provider-session-id") {
      if (rec.provider !== "codex") return;
      // Production exact identity is resolver-owned. OSC ids remain a compatibility signal only when no
      // resolver was configured (principally isolated adapter/manager tests).
      if (this.deps.codexThreadResolver) return;
      if (rec.identityAmbiguous || (rec.providerSessionId && rec.providerSessionId !== signal.id)) {
        rec.identityAmbiguous = true;
        rec.providerSessionId = undefined;
        rec.meta.identityState = "ambiguous";
        rec.meta.providerSessionId = undefined;
        this.deps.store.setProviderSessionId(id, undefined);
        return;
      }
      try {
        this.deps.store.setProviderSessionId(id, signal.id);
        rec.providerSessionId = signal.id;
        rec.meta.identityState = "exact";
        rec.meta.providerSessionId = signal.id;
      } catch {
        rec.identityAmbiguous = true;
        rec.providerSessionId = undefined;
        rec.meta.identityState = "ambiguous";
        rec.meta.providerSessionId = undefined;
        try {
          this.deps.store.setProviderSessionId(id, undefined);
        } catch {
          /* already fail-closed in memory */
        }
      }
      return;
    }
    const wasBlocked = rec.meta.awaiting;
    rec.meta.activity = signal.type;
    rec.meta.awaiting = signal.type === "blocked";
    if (rec.meta.awaiting && !wasBlocked && rec.subs.size === 0) {
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
      rec.meta.activity = "working";
      this.clearAwaiting(rec);
      rec.meta.lastActivityAt = this.deps.now();
      this.deps.store.touch(id, rec.meta.lastActivityAt);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.cols = clampDim(cols, rec.cols);
    rec.rows = clampDim(rows, rec.rows);
    rec.proc?.resize(rec.cols, rec.rows);
  }

  stop(id: string): void {
    const rec = this.records.get(id);
    this.records.delete(id);
    if (rec?.proc) {
      const proc = rec.proc;
      rec.proc = undefined;
      proc.removeAllListeners();
      proc.stop({ kill: true });
    } else this.killTmux(id);
    if (rec) {
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
      try {
        this.providers.get(s.provider);
      } catch {
        continue; // retain the durable row and live tmux session; never launch under another provider
      }
      let parsedOptions: ProviderSessionOptions;
      try {
        parsedOptions = s.provider === "claude" ? parseLegacyClaudeArgs(s.spawnArgs ?? []) : s.launchOptions;
      } catch {
        continue; // isolate malformed historical options to this row; retain it for diagnostics
      }
      const options: ProviderSessionOptions =
        s.provider === "claude" && parsedOptions.provider === "claude" && s.dangerouslySkip
          ? { ...parsedOptions, dangerouslySkip: true }
          : parsedOptions;
      const common: RecordBase = {
        meta: {
          id: s.id,
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
              : options.dangerouslyBypassApprovalsAndSandbox === true,
          model: options.model,
          effort: options.provider === "claude" ? options.effort : options.reasoningEffort,
          ...(options.provider === "claude"
            ? { permissionMode: options.permissionMode }
            : { sandbox: options.sandbox, approvalPolicy: options.approvalPolicy }),
          // The user's rename survives a server restart the same way.
          name: s.name,
          ...(s.provider === "codex"
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
      if (s.provider === "claude" && options.provider === "claude") {
        this.records.set(s.id, { ...common, provider: "claude", options });
      } else if (s.provider === "codex" && options.provider === "codex") {
        this.records.set(s.id, {
          ...common,
          provider: "codex",
          options,
          ...(s.providerSessionId ? { providerSessionId: s.providerSessionId } : {}),
          identityAmbiguous: false,
        });
      }
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
