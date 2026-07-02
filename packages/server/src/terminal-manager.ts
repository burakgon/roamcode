// packages/server/src/terminal-manager.ts
import { writeFileSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TerminalProcess, tmuxSessionName, type PtySpawn } from "./terminal-process.js";
import {
  buildMcpConfigDocument,
  mcpConfigPathFor,
  buildHooksSettingsDocument,
  hooksSettingsPathFor,
  hookAuthPathFor,
  hookAuthFileContent,
} from "./config.js";
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
   * "claude finished its turn and is waiting on YOU." Set DETERMINISTICALLY by claude's own `Stop` hook (and
   * the ask_user flow), cleared by its `UserPromptSubmit` hook + any fresh pty output — see
   * config.buildHooksSettingsDocument. Replaces the old terminal-output-idle scraping, which couldn't tell
   * "generating / waiting on a background agent" from "waiting for you" and fired false positives. Surfaced in
   * GET /sessions so the web can badge it.
   */
  awaiting: boolean;
  /**
   * Whether this session's claude runs with `--dangerously-skip-permissions` (RCE-by-design: claude can run
   * any tool without asking). Derived at create() from the spawn args, persisted, and surfaced in GET /sessions
   * so the web rail can badge a session as running in skip-permissions mode.
   */
  dangerouslySkip: boolean;
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
  /** Per-session 0600 files for claude's Stop/UserPromptSubmit hooks: the settings doc (passed as --settings)
   *  and the auth-header file the hook curls read (-H '@file'). Both cleaned on stop. */
  hooksConfigPath?: string;
  hookAuthPath?: string;
  /**
   * Bounded, in-memory buffer of `attach` control frames (files/images claude sent) so a client that
   * (re)connects LATER still sees files that arrived while it was away — pushControl only reaches clients
   * attached at send-time. Replayed to each newly-attached client. Not durable across a server restart.
   */
  attachments: unknown[];
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
  /**
   * Best-effort notifier fired when a session's claude exits (the "done" ping). `wasAttached` reports whether
   * a client was still attached at the moment of exit — captured BEFORE the subs are torn down — so the
   * transport can gate the away-from-desk push on "nobody was watching" (you already see the WS close when you
   * are). Same never-throw contract.
   */
  onFinished?: (id: string, wasAttached: boolean) => void;
}

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
    // Derive the RCE-skip flag from the spawn args (the transport pushes `--dangerously-skip-permissions`
    // there when the client asks for it), rather than hardcoding false — so it's stored + surfaced honestly.
    const dangerouslySkip = (opts.claudeArgs ?? []).includes("--dangerously-skip-permissions");
    const meta: TerminalMeta = {
      id: opts.id,
      cwd: opts.cwd,
      mode: "terminal",
      status: "running",
      createdAt: now,
      lastActivityAt: now,
      awaiting: false,
      dangerouslySkip,
    };
    const claudeArgs = [...(opts.claudeArgs ?? [])];
    // Give the terminal's claude the remote-coder MCP (send_image/send_file), same as chat sessions: write
    // the per-session 0600 config file and pass its path. Degrade gracefully (no attachments) on any failure.
    const mcpConfigPath = this.writeMcpConfig(opts.id);
    if (mcpConfigPath) claudeArgs.push("--mcp-config", mcpConfigPath);
    // Deterministic "needs you": claude's own Stop/UserPromptSubmit hooks tell us when it's waiting on the
    // user vs still working (a background agent / a tool) — no fragile terminal scraping. Degrade gracefully.
    const hooks = this.writeHooksConfig(opts.id);
    if (hooks) claudeArgs.push("--settings", hooks.configPath);
    this.records.set(opts.id, {
      meta,
      claudeArgs,
      cols: clampDim(opts.cols, 80),
      rows: clampDim(opts.rows, 24),
      subs: new Set(),
      mcpConfigPath,
      hooksConfigPath: hooks?.configPath,
      hookAuthPath: hooks?.authPath,
      attachments: [],
    });
    this.deps.store.upsert({
      id: opts.id,
      cwd: opts.cwd,
      mode: "terminal",
      dangerouslySkip,
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

  /** Write the per-session 0600 hooks settings + auth-header files; returns their paths (or undefined → spawn
   *  without hooks, so claude just won't emit the Stop/UserPromptSubmit "needs you" signals). The auth file
   *  holds `Authorization: Bearer <token>` so the hook curls read it via `-H '@file'` (token never in argv). */
  private writeHooksConfig(id: string): { configPath: string; authPath: string } | undefined {
    if (!this.attachConfig) return undefined;
    try {
      const dir = this.attachConfig.dataDir;
      const authPath = hookAuthPathFor(dir, id);
      writeFileSync(authPath, hookAuthFileContent(this.attachConfig.token), { mode: 0o600 });
      chmodSync(authPath, 0o600);
      const configPath = hooksSettingsPathFor(dir, id);
      writeFileSync(configPath, JSON.stringify(buildHooksSettingsDocument(id, this.attachConfig, authPath)), {
        mode: 0o600,
      });
      chmodSync(configPath, 0o600);
      return { configPath, authPath };
    } catch {
      return undefined; // graceful degrade — terminal still works, just without hook-driven "needs you"
    }
  }

  /**
   * Delete stale per-session 0600 files that hold the access token — `mcp-config-<id>.json`, `hooks-<id>.json`,
   * and `hook-auth-<id>`. A file is stale when no live session owns its id: leaked by a crash, an orphan-reap,
   * a rehydrated record (which carries no such paths, so stop() never unlinks its files), or a token rotation.
   * Call at boot AFTER rehydrate + setAttachConfig so `records` reflects the surviving sessions. No-op without
   * an attach config.
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
   * Set a session's `awaiting` flag ("claude finished its turn and is waiting on YOU"). Driven by claude's
   * `Stop` hook (→ true) and `UserPromptSubmit` hook (→ false), plus the ask_user flow (→ true). Deterministic:
   * no timers, no terminal scraping. A missing session is a no-op. Does NOT fire the away-from-desk push — the
   * hook route (and the ask route) own that, so they can gate it on {@link isAttached}.
   */
  setAwaiting(id: string, value: boolean): void {
    const rec = this.records.get(id);
    if (rec) rec.meta.awaiting = value;
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
        // NOTE: output does NOT touch `awaiting`. It's set/cleared ONLY by deterministic signals — claude's
        // Stop hook + the ask_user flow set it; UserPromptSubmit + user input clear it. Clearing on output was
        // WRONG: while claude waits at an ask_user question (or the idle prompt) its TUI keeps repainting the
        // cursor/spinner, which would instantly clear the flag → the session never entered "needs you".
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
        // Capture attachment BEFORE clearing the subs, so the transport can tell whether anyone was watching
        // when claude exited (an attached client already sees the WS close — no need to also push it).
        const wasAttached = dying.length > 0;
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
          this.deps.onFinished?.(id, wasAttached);
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
    } else {
      // Reattaching to a STILL-RUNNING session: its pty/tmux client is alive from an earlier connection whose
      // WS never cleanly closed (e.g. the app was backgrounded a long time, so the old sub lingered and the pty
      // wasn't torn down + respawned). tmux drew its screen to that pty long ago, so THIS fresh xterm receives
      // no redraw and shows only a blinking cursor until something changes — the reported "open an old chat →
      // blank until I resize the window" bug. Nudge tmux to repaint the whole screen. See forceRedraw.
      this.forceRedraw(rec);
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
    if (rec?.proc) rec.proc.stop({ kill: true });
    else this.killTmux(id);
    // Best-effort: don't leak the per-session 0600 files (they hold the token) after close.
    for (const p of [rec?.mcpConfigPath, rec?.hooksConfigPath, rec?.hookAuthPath]) {
      if (!p) continue;
      try {
        unlinkSync(p);
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
          // Preserve the persisted RCE-skip flag so a rehydrated session is still badged correctly (the
          // spawn args aren't known here — this is the only source of truth after a restart).
          dangerouslySkip: s.dangerouslySkip,
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
