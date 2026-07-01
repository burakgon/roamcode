// packages/server/src/terminal-manager.ts
import { writeFileSync, chmodSync, unlinkSync } from "node:fs";
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
}

export interface TerminalManagerDeps {
  store: SessionStore;
  claudeBin: string;
  now: () => number;
  ptySpawn?: PtySpawn;
  runTmux?: (args: string[]) => void;
  env?: NodeJS.ProcessEnv;
}

const clampDim = (n: number | undefined, fallback: number): number => Math.max(1, Math.trunc(n ?? fallback) || fallback);

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
      id: opts.id, cwd: opts.cwd, mode: "terminal", status: "running", createdAt: now, lastActivityAt: now,
    };
    const claudeArgs = [...(opts.claudeArgs ?? [])];
    // Give the terminal's claude the remote-coder MCP (send_image/send_file), same as chat sessions: write
    // the per-session 0600 config file and pass its path. Degrade gracefully (no attachments) on any failure.
    const mcpConfigPath = this.writeMcpConfig(opts.id);
    if (mcpConfigPath) claudeArgs.push("--mcp-config", mcpConfigPath);
    this.records.set(opts.id, {
      meta, claudeArgs, cols: clampDim(opts.cols, 80), rows: clampDim(opts.rows, 24), subs: new Set(), mcpConfigPath,
    });
    this.deps.store.upsert({
      id: opts.id, cwd: opts.cwd, mode: "terminal", dangerouslySkip: false,
      status: "running", createdAt: now, lastActivityAt: now,
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

  /** Push a JSON control message (file/image attachment) to every attached client of a terminal session. */
  pushControl(id: string, msg: unknown): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
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
    if (!rec.proc) {
      const proc = new TerminalProcess({
        sessionId: id, cwd: rec.meta.cwd, claudeBin: this.deps.claudeBin,
        claudeArgs: rec.claudeArgs, cols: rec.cols, rows: rec.rows,
        ...(this.deps.env ? { env: this.deps.env } : {}),
        ...(this.deps.ptySpawn ? { ptySpawn: this.deps.ptySpawn } : {}),
        ...(this.deps.runTmux ? { runTmux: this.deps.runTmux } : {}),
      });
      proc.on("data", (chunk) => {
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
      },
    };
  }

  write(id: string, data: string): void {
    const rec = this.records.get(id);
    rec?.proc?.write(data);
    if (rec) {
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
      this.deps.store.list().filter((s) => s.mode === "terminal").map((s) => s.id),
    );
    for (const s of this.deps.store.list()) {
      if (s.mode !== "terminal") continue;
      if (!live.has(tmuxSessionName(s.id))) {
        this.deps.store.delete(s.id); // tmux session gone → prune the stale row
        continue;
      }
      if (this.records.has(s.id)) continue;
      this.records.set(s.id, {
        meta: { id: s.id, cwd: s.cwd, mode: "terminal", status: "running", createdAt: s.createdAt, lastActivityAt: s.lastActivityAt },
        claudeArgs: [], cols: 80, rows: 24, subs: new Set(),
      });
    }
    for (const name of opts.liveTmuxNames) {
      if (!name.startsWith("rc-")) continue;
      const id = name.slice(3);
      if (!storedTerminalIds.has(id)) this.killTmux(id); // orphan → reap
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
