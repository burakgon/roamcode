// packages/server/src/terminal-manager.ts
import { writeFileSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TerminalProcess, tmuxSessionName, type PtySpawn } from "./terminal-process.js";
import { buildMcpConfigDocument, mcpConfigPathFor } from "./config.js";
import type { AttachSpawnOptions } from "./config.js";
import type { SessionStore } from "./session-store.js";

export interface TerminalMeta {
  id: string;
  cwd: string;
  mode: "terminal";
  status: "running" | "ended";
  createdAt: number;
  lastActivityAt: number;
  /**
   * Best-effort "claude has gone quiet and is likely waiting for you" flag (the pty went output-idle for a
   * few seconds after a burst — see {@link TerminalManager}). Surfaced in GET /sessions so the web
   * SessionList can badge it. Conservative: false unless we're fairly sure; a missed true is fine.
   */
  awaiting: boolean;
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
}

interface Record_ {
  meta: TerminalMeta;
  claudeArgs: string[];
  cols: number;
  rows: number;
  proc?: TerminalProcess;
  subs: Set<TermSub>;
  /** Per-session 0600 MCP config file path (so the terminal's claude gets send_image/send_file); cleaned on stop. */
  mcpConfigPath?: string;
  /**
   * Bounded, in-memory buffer of `attach` control frames (files/images claude sent) so a client that
   * (re)connects LATER still sees files that arrived while it was away — pushControl only reaches clients
   * attached at send-time. Replayed to each newly-attached client. Not durable across a server restart.
   */
  attachments: unknown[];
  /** Pending output-idle timer for the awaiting heuristic (unref'd; cleared on input/output/exit/stop). */
  awaitTimer?: NodeJS.Timeout;
}

export interface TerminalManagerDeps {
  store: SessionStore;
  claudeBin: string;
  now: () => number;
  ptySpawn?: PtySpawn;
  runTmux?: (args: string[]) => void;
  env?: NodeJS.ProcessEnv;
  /**
   * Best-effort notifier fired on a false→true `awaiting` transition WHEN NO CLIENT IS ATTACHED (i.e. the
   * user is away from the desk). Wired by the transport to the push dispatcher; omitted in tests. Called in
   * a try/catch — a throw here can NEVER break the terminal.
   */
  onAwaiting?: (id: string) => void;
  /** Best-effort notifier fired when a session's claude exits (the "done" ping). Same never-throw contract. */
  onFinished?: (id: string) => void;
  /**
   * How long the pty must stay output-idle after a burst before we mark `awaiting` (the "claude finished a
   * turn / is at a prompt" heuristic). Injectable so tests can use a tiny value; defaults to
   * {@link TERMINAL_AWAIT_IDLE_MS}.
   */
  awaitIdleMs?: number;
}

/** Default output-idle window before a running session is heuristically marked `awaiting` (see above). */
export const TERMINAL_AWAIT_IDLE_MS = 4000;

/** Cap the per-session replay buffer of attachment frames so a long-lived session can't grow unbounded. */
const MAX_ATTACHMENT_BUFFER = 50;

const clampDim = (n: number | undefined, fallback: number): number =>
  Math.max(1, Math.trunc(n ?? fallback) || fallback);

export class TerminalManager {
  private readonly records = new Map<string, Record_>();
  private attachConfig?: AttachSpawnOptions;
  constructor(private readonly deps: TerminalManagerDeps) {}

  /** Late-bound (after listen(), which resolves the loopback port) — same config the chat SessionManager
   *  gets. When set, each terminal's claude is spawned with `--mcp-config` so send_image/send_file work. */
  setAttachConfig(attach: AttachSpawnOptions | undefined): void {
    this.attachConfig = attach;
  }

  create(opts: { id: string; cwd: string; claudeArgs?: string[]; cols?: number; rows?: number }): TerminalMeta {
    const now = this.deps.now();
    const meta: TerminalMeta = {
      id: opts.id,
      cwd: opts.cwd,
      mode: "terminal",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
      awaiting: false,
    };
    const claudeArgs = [...(opts.claudeArgs ?? [])];
    // Give the terminal's claude the remote-coder MCP (send_image/send_file), same as chat sessions: write
    // the per-session 0600 config file and pass its path. Degrade gracefully (no attachments) on any failure.
    const mcpConfigPath = this.writeMcpConfig(opts.id);
    if (mcpConfigPath) claudeArgs.push("--mcp-config", mcpConfigPath);
    this.records.set(opts.id, {
      meta,
      claudeArgs,
      cols: clampDim(opts.cols, 80),
      rows: clampDim(opts.rows, 24),
      subs: new Set(),
      mcpConfigPath,
      attachments: [],
    });
    this.deps.store.upsert({
      id: opts.id,
      cwd: opts.cwd,
      mode: "terminal",
      dangerouslySkip: false,
      status: "running",
      createdAt: now,
      lastActivityAt: now,
    });
    return meta;
  }

  /** Write the per-session mode-0600 MCP config file; returns its path, or undefined (spawn without it). */
  private writeMcpConfig(id: string): string | undefined {
    if (!this.attachConfig) return undefined;
    try {
      const path = mcpConfigPathFor(this.attachConfig.dataDir, id);
      writeFileSync(path, JSON.stringify(buildMcpConfigDocument(id, this.attachConfig)), { mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    } catch {
      return undefined; // graceful degrade — terminal still works, just without attachment tools
    }
  }

  /**
   * Delete stale per-session `mcp-config-<id>.json` files — the 0600 files hold the access token. A file is
   * stale when no live session owns its id: leaked by a crash, an orphan-reap, a rehydrated record (which
   * carries no mcpConfigPath, so stop() never unlinks its file), or a token rotation. Call at boot AFTER
   * rehydrate + setAttachConfig so `records` reflects the surviving sessions. No-op without an attach config.
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
      const m = /^mcp-config-(.+)\.json$/.exec(name);
      if (!m || liveIds.has(m[1]!)) continue;
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
   * Explicitly set a session's `awaiting` flag. Used by the ask flow (claude is BLOCKED on the user, so it
   * is definitely awaiting) — distinct from the output-idle heuristic. Setting true cancels any pending
   * idle timer so it can't later flip the flag back on redundantly; setting false clears both. A missing
   * session is a no-op. Does NOT fire {@link TerminalManagerDeps.onAwaiting} — the caller owns that push.
   */
  setAwaiting(id: string, value: boolean): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (value) {
      this.clearAwaitTimer(rec);
      rec.meta.awaiting = true;
    } else {
      this.clearAwaiting(rec);
    }
  }

  /** Clear a record's pending output-idle timer (if any). */
  private clearAwaitTimer(rec: Record_): void {
    if (rec.awaitTimer) {
      clearTimeout(rec.awaitTimer);
      rec.awaitTimer = undefined;
    }
  }

  /** Clear the awaiting flag AND any pending idle timer (user is active / session ended). */
  private clearAwaiting(rec: Record_): void {
    this.clearAwaitTimer(rec);
    rec.meta.awaiting = false;
  }

  /**
   * (Re)arm the output-idle timer: after `awaitIdleMs` of NO further output, flip a RUNNING session to
   * awaiting (claude likely finished a turn / is at a prompt) and — only if no client is attached (the user
   * is away) — fire onAwaiting for a push. Conservative on purpose: continuous output (streaming, a spinner)
   * keeps resetting this so we never falsely ping mid-work. unref'd so it never keeps the process alive.
   */
  private armAwaitTimer(id: string, rec: Record_): void {
    this.clearAwaitTimer(rec);
    const idleMs = this.deps.awaitIdleMs ?? TERMINAL_AWAIT_IDLE_MS;
    const timer = setTimeout(() => {
      rec.awaitTimer = undefined;
      if (rec.meta.status !== "running" || rec.meta.awaiting) return;
      rec.meta.awaiting = true;
      // Away-from-desk: only PUSH when nobody is watching. The flag still flips for the SessionList badge.
      if (rec.subs.size === 0) {
        try {
          this.deps.onAwaiting?.(id);
        } catch {
          /* a push must NEVER break the terminal */
        }
      }
    }, idleMs);
    if (typeof timer.unref === "function") timer.unref();
    rec.awaitTimer = timer;
  }

  /**
   * Subscribe to a terminal's output. The pty/tmux is spawned lazily on the FIRST subscriber — and, when
   * `size` is given, born at exactly the client's fitted viewport so the claude TUI's first frame matches
   * (no spawn-at-80×24-then-reflow jump). Returns undefined for an unknown id.
   */
  attach(
    id: string,
    handlers: { onData: (chunk: string) => void; onExit?: () => void; onControl?: (msg: string) => void },
    size?: { cols: number; rows: number },
  ): TerminalSub | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    if (size && !rec.proc) {
      rec.cols = clampDim(size.cols, rec.cols);
      rec.rows = clampDim(size.rows, rec.rows);
    }
    const sub: TermSub = { onData: handlers.onData, onExit: handlers.onExit, onControl: handlers.onControl };
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
    if (!rec.proc) {
      const proc = new TerminalProcess({
        sessionId: id,
        cwd: rec.meta.cwd,
        claudeBin: this.deps.claudeBin,
        claudeArgs: rec.claudeArgs,
        cols: rec.cols,
        rows: rec.rows,
        ...(this.deps.env ? { env: this.deps.env } : {}),
        ...(this.deps.ptySpawn ? { ptySpawn: this.deps.ptySpawn } : {}),
        ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
      });
      proc.on("data", (chunk) => {
        // Fresh output → claude is active again: clear any awaiting state and (re)arm the output-idle
        // detector so a subsequent quiet window flips awaiting back on. Best-effort, before fan-out.
        rec.meta.awaiting = false;
        this.armAwaitTimer(id, rec);
        // Snapshot + per-sub try/catch: one wedged client's throw must not drop the frame for the others.
        for (const s of [...rec.subs]) {
          try {
            s.onData(chunk);
          } catch {
            /* ignore a bad sink */
          }
        }
      });
      proc.on("exit", () => {
        // claude exited (remain-on-exit off → the tmux session is gone). Mark ended, drop the proc, and
        // NOTIFY every attached client so they can show a Restart/Close overlay instead of a frozen screen.
        rec.meta.status = "ended";
        this.clearAwaiting(rec); // an ended session is not "awaiting"
        rec.proc = undefined;
        const dying = [...rec.subs];
        rec.subs.clear();
        for (const s of dying) {
          try {
            s.onExit?.();
          } catch {
            /* ignore */
          }
        }
        // The "done" ping. Best-effort — a throw here must never take down the terminal teardown.
        try {
          this.deps.onFinished?.(id);
        } catch {
          /* ignore */
        }
      });
      // Reattaching to an ended terminal (Restart) spawns a FRESH claude → back to running.
      rec.meta.status = "running";
      rec.proc = proc;
      try {
        proc.start();
      } catch {
        // Spawn failed (bad cwd, node-pty missing) → don't leave a half-attached record; let the caller 4404.
        rec.proc = undefined;
        rec.meta.status = "ended";
        rec.subs.delete(sub);
        return undefined;
      }
    }
    return {
      unsubscribe: () => {
        rec.subs.delete(sub);
        // No subscribers left → detach the pty client; tmux + claude keep running for reconnect.
        if (rec.subs.size === 0 && rec.proc) {
          rec.proc.removeAllListeners();
          rec.proc.stop();
          rec.proc = undefined;
        }
        // WALK-AWAY PING: the last client detached while claude was already awaiting the user — now that
        // nobody is watching, fire the away-from-desk push (the idle-timer path only fires on a transition
        // that happens WHILE away, so this covers "you were watching claude wait, then left"). Best-effort.
        if (rec.subs.size === 0 && rec.meta.awaiting && rec.meta.status === "running") {
          try {
            this.deps.onAwaiting?.(id);
          } catch {
            /* a push must NEVER break the terminal */
          }
        }
      },
    };
  }

  write(id: string, data: string): void {
    const rec = this.records.get(id);
    rec?.proc?.write(data);
    if (rec) {
      // User input → not awaiting; clear the flag + any pending idle timer (fresh output re-arms it).
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
    if (rec) this.clearAwaitTimer(rec); // don't leak the pending idle timer for a killed session
    if (rec?.proc) rec.proc.stop({ kill: true });
    else this.killTmux(id);
    if (rec?.mcpConfigPath) {
      try {
        unlinkSync(rec.mcpConfigPath); // best-effort: don't leak the 0600 config (with the token) after close
      } catch {
        /* already gone */
      }
    }
    this.records.delete(id);
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
      this.records.set(s.id, {
        meta: {
          id: s.id,
          cwd: s.cwd,
          mode: "terminal",
          status: "running",
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
          awaiting: false,
        },
        claudeArgs: [],
        cols: 80,
        rows: 24,
        subs: new Set(),
        attachments: [],
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
      claudeBin: this.deps.claudeBin,
      ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
    }).stop({ kill: true });
  }
}
