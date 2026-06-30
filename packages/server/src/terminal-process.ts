// packages/server/src/terminal-process.ts
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface IPty {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(sig?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
) => IPty;

export interface TerminalProcessOptions {
  sessionId: string;
  cwd: string;
  claudeBin: string;
  claudeArgs?: string[];
  tmuxBin?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable PTY spawner (default loads node-pty). Tests pass a fake. */
  ptySpawn?: PtySpawn;
  /** Injectable one-shot tmux command runner (set-option / kill-session). Default spawnSync(tmuxBin). */
  runTmux?: (args: string[]) => void;
}

/** The tmux session name for a remote-coder session id. Stable so attach/kill always target the same one. */
export function tmuxSessionName(id: string): string {
  return `rc-${id}`;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class TerminalProcess extends EventEmitter {
  readonly tmuxName: string;
  private readonly opts: TerminalProcessOptions;
  private pty?: IPty;
  private started = false;
  private readonly tmuxBin: string;
  private readonly runTmux: (args: string[]) => void;
  private readonly ptySpawn: PtySpawn;

  constructor(opts: TerminalProcessOptions) {
    super();
    this.opts = opts;
    this.tmuxName = tmuxSessionName(opts.sessionId);
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    this.runTmux = opts.runTmux ?? ((args) => void spawnSync(this.tmuxBin, args, { stdio: "ignore" }));
    this.ptySpawn = opts.ptySpawn ?? defaultPtySpawn;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const cols = this.opts.cols ?? 80;
    const rows = this.opts.rows ?? 24;
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    delete env.ANTHROPIC_API_KEY;
    const args = [
      "new-session", "-A", "-s", this.tmuxName,
      "-x", String(cols), "-y", String(rows),
      "--", this.opts.claudeBin, ...(this.opts.claudeArgs ?? []),
    ];
    const pty = this.ptySpawn(this.tmuxBin, args, { name: "xterm-256color", cols, rows, cwd: this.opts.cwd, env });
    this.pty = pty;
    pty.onData((d) => this.emit("data", d));
    pty.onExit((e) => this.emit("exit", e));
    // Keep the session alive if claude exits, so an accidental exit leaves a restartable pane.
    this.runTmux(["set-option", "-t", this.tmuxName, "remain-on-exit", "on"]);
  }

  write(d: string): void {
    this.pty?.write(d);
  }

  resize(c: number, r: number): void {
    this.pty?.resize(c, r);
  }

  /** Detach (kill the pty client; tmux + claude keep running). `kill:true` also kills the tmux session. */
  stop(opts: { kill?: boolean } = {}): void {
    if (opts.kill) this.runTmux(["kill-session", "-t", this.tmuxName]);
    try {
      this.pty?.kill();
    } catch {
      // pty already gone — best-effort
    }
    this.pty = undefined;
  }
}

/** Default spawner: lazy-load node-pty so a missing native module never breaks module import. */
const defaultPtySpawn: PtySpawn = (file, args, opts) => {
  const pty = require("node-pty") as typeof import("node-pty");
  return pty.spawn(file, args, opts) as unknown as IPty;
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface TerminalProcess {
  on(event: "data", listener: (chunk: string) => void): this;
  on(event: "exit", listener: (info: { exitCode: number }) => void): this;
  emit(event: "data", chunk: string): boolean;
  emit(event: "exit", info: { exitCode: number }): boolean;
}
