// packages/server/src/terminal-process.ts
import { spawn } from "node:child_process";
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
  executable: string;
  args?: string[];
  /** Attach to an already-proven live tmux session without supplying a provider command. If the session
   * disappeared, tmux fails closed instead of silently creating a fresh, identity-ambiguous conversation. */
  attachOnly?: boolean;
  tmuxBin?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable PTY spawner (default loads node-pty). Tests pass a fake. */
  ptySpawn?: PtySpawn;
  /** Injectable one-shot tmux command runner (kill-session). Default: async fire-and-forget spawn. */
  runTmux?: (args: string[]) => void;
  /** Dedicated tmux server socket (`-L <socket>`). Defaults to {@link TMUX_SOCKET}. Injected by the
   *  real-tmux integration test so it runs on a UNIQUE socket and can NEVER touch the live "roamcode"
   *  server (a shared socket is how the full suite used to kill a running session). */
  tmuxSocket?: string;
}

/** Dedicated tmux server socket — ISOLATES roamcode's sessions from the host user's own tmux (their
 *  `tmux ls` never shows `rc-*`, a stray `kill-server` can't nuke ours, and our global options never touch
 *  theirs). Every tmux invocation must pass `-L <SOCKET>`. Overridable via RC_TMUX_SOCKET so a SECOND
 *  instance (a test/verification server) gets its own socket and never reaps the primary server's
 *  sessions on boot (rehydrate treats unknown `rc-*` as orphans). Default is unchanged in production.
 *
 *  The default keeps the PRE-RENAME name "remote-coder" ON PURPOSE: live terminal sessions exist on this
 *  socket, and an OTA update restarts the server in place — a renamed socket would boot into an empty tmux
 *  server and strand every running session (still-running claudes, invisible to the UI). RC = RoamCode. */
export const TMUX_SOCKET = process.env.RC_TMUX_SOCKET || "remote-coder";

/** The tmux session name for a roamcode session id. Stable so attach/kill always target the same one. */
export function tmuxSessionName(id: string): string {
  return `rc-${id}`;
}

/** Server-wide tmux options that make the embedded session behave like a plain, transparent terminal rather
 *  than a visible tmux: NO status bar (it stole a row and made the TUI look shifted), instant escape-time (the
 *  500ms default mangled Esc-prefixed sequences = arrow/alt keys), mouse + focus + clipboard passthrough, and
 *  a 256-color terminfo. Set as ONE chained command BEFORE `new-session` so claude renders full-height from
 *  its first frame (no status-bar reflow). Applied on our dedicated socket, so they never affect the user's tmux. */
function tmuxConfigChain(): string[] {
  const sets: Array<[scope: string, name: string, value: string]> = [
    ["-g", "status", "off"],
    ["-s", "escape-time", "0"],
    // mouse OFF: with mouse on, tmux captures the browser's mouse events (SGR tracking), which breaks
    // xterm.js native text-selection/copy and wheel-scroll. claude's TUI is keyboard-driven, so leaving
    // mouse off lets the browser own selection + scrolling — the behavior a web terminal user expects.
    ["-g", "mouse", "off"],
    ["-g", "focus-events", "on"],
    ["-g", "set-clipboard", "on"],
    // Codex wraps OSC 9 notifications in tmux passthrough frames. `-q` keeps older tmux versions compatible
    // if the option is unknown; supported versions forward the bounded frames to the runtime parser.
    ["-gq", "allow-passthrough", "on"],
    ["-g", "default-terminal", "tmux-256color"],
    // remain-on-exit OFF: if claude exits, END the tmux session instead of leaving a frozen, untypeable
    // [exited] pane that nothing respawns. The server forwards the exit to the client (which shows a
    // Restart/Close overlay); a Restart re-attaches and `new-session -A` then spawns a FRESH claude.
    ["-g", "remain-on-exit", "off"],
  ];
  return [
    ...sets.flatMap(([scope, name, value]) => ["set-option", scope, name, value, ";"]),
    // tmux is a long-lived server: without this allow-list, a later session inherits the FIRST tmux client's
    // RC_* environment and Codex MCP can target the wrong RoamCode session. Strip every exact occurrence,
    // then append the full bundle once. Lookalike names survive, the list cannot grow on each launch, and
    // only variable NAMES enter argv (the token value remains solely in the PTY client's environment).
    "set-option",
    "-Fg",
    "update-environment",
    "#{s,(^| )RC_BASE_URL( |$), ,:#{s,(^| )RC_SESSION_ID( |$), ,:#{s,(^| )RC_TOKEN( |$), ,:#{s,(^| )RC_TOKEN_FILE( |$), ,:#{update-environment}}}}} RC_BASE_URL RC_SESSION_ID RC_TOKEN RC_TOKEN_FILE",
    ";",
  ];
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
  private readonly tmuxSocket: string;

  constructor(opts: TerminalProcessOptions) {
    super();
    this.opts = opts;
    this.tmuxName = tmuxSessionName(opts.sessionId);
    this.tmuxBin = opts.tmuxBin ?? "tmux";
    // Default runner is an ASYNC fire-and-forget spawn (was spawnSync, which BLOCKED the event loop for
    // the full tmux round-trip on every kill — stalling every other live session's WS/pty traffic while a
    // session closed). Nothing consumes the result: the tmux session is either killed or was already gone,
    // so errors are swallowed and the child is unref'd (it must never hold the server process open).
    // The injectable signature is unchanged — tests/callers that inject their own runner are unaffected.
    this.runTmux =
      opts.runTmux ??
      ((args) => {
        try {
          const child = spawn(this.tmuxBin, args, { stdio: "ignore" });
          child.on("error", () => {
            /* tmux missing / spawn failed — nothing to kill */
          });
          child.unref();
        } catch {
          /* defensive: spawn with an args array shouldn't throw, but stop() must never crash a teardown */
        }
      });
    this.ptySpawn = opts.ptySpawn ?? defaultPtySpawn;
    this.tmuxSocket = opts.tmuxSocket ?? TMUX_SOCKET;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const cols = Math.max(1, this.opts.cols ?? 80);
    const rows = Math.max(1, this.opts.rows ?? 24);
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    // Strip TMUX/TMUX_PANE so a server itself running inside tmux can't make our `tmux` child think it's
    // nesting (which makes it refuse / attach to the wrong server). Provider-specific env policy belongs to
    // the provider that built this process spec.
    delete env.TMUX;
    delete env.TMUX_PANE;
    // UTF-8 LOCALE: a server launched by launchd/systemd often has NO locale env, so tmux assumes a non-UTF-8
    // terminal and DOWNGRADES wide/block-element glyphs to ASCII — that's what turned claude's logo (drawn
    // with █▛▜▌▐) into coral dashes + black boxes in the browser. Guarantee a UTF-8 locale so tmux passes the
    // glyphs through verbatim. (Belt-and-suspenders with tmux's `-u` flag below.)
    if (!/utf-?8/i.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "")) {
      env.LANG = "en_US.UTF-8";
      env.LC_CTYPE = "en_US.UTF-8";
    }
    // ONE command on our dedicated socket: configure the server, THEN attach-or-create the session running
    // claude. `;` tokens are tmux command separators (no shell involved). `-A` = attach if it already exists.
    // `-u` forces tmux to treat the (node-pty) client as UTF-8 capable regardless of the locale it detects.
    const terminalCommand = this.opts.attachOnly
      ? ["attach-session", "-t", this.tmuxName]
      : [
          "new-session",
          "-A",
          "-s",
          this.tmuxName,
          "-x",
          String(cols),
          "-y",
          String(rows),
          "--",
          this.opts.executable,
          ...(this.opts.args ?? []),
        ];
    const args = ["-L", this.tmuxSocket, "-u", ...tmuxConfigChain(), ...terminalCommand];
    const pty = this.ptySpawn(this.tmuxBin, args, { name: "xterm-256color", cols, rows, cwd: this.opts.cwd, env });
    this.pty = pty;
    pty.onData((d) => this.emit("data", d));
    pty.onExit((e) => this.emit("exit", e));
  }

  write(d: string): void {
    try {
      this.pty?.write(d);
    } catch {
      // pty gone (claude exited / detached) — drop the write rather than crash the connection.
    }
  }

  resize(c: number, r: number): void {
    // Clamp BOTH ends: a transient 0/NaN from a pre-layout fit() or an absurd client value (e.g. 1e9) would
    // otherwise hit ioctl(TIOCSWINSZ) and throw / allocate huge line buffers. 1000 is far beyond any viewport.
    const clamp = (n: number): number => Math.min(1000, Math.max(1, Math.trunc(n) || 1));
    try {
      this.pty?.resize(clamp(c), clamp(r));
    } catch {
      // pty gone or rejected the dims — best-effort.
    }
  }

  /** Detach (kill the pty client; tmux + claude keep running). `kill:true` also kills the tmux session. */
  stop(opts: { kill?: boolean } = {}): void {
    if (opts.kill) this.runTmux(["-L", this.tmuxSocket, "kill-session", "-t", this.tmuxName]);
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
