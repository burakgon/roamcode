// packages/server/src/terminal-process.ts
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { ensureNodePtySpawnHelperExecutable } from "./node-pty-runtime.js";
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
  /** Enable tmux mouse history for this session only. Codex uses inline mode; Claude keeps its existing
   * alternate-screen behavior and browser-owned selection. */
  enableMouseHistory?: boolean;
  tmuxBin?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable PTY spawner (default loads node-pty). Tests pass a fake. */
  ptySpawn?: PtySpawn;
  /** Injectable one-shot tmux command runner (kill-session). Default: async fire-and-forget spawn. */
  runTmux?: (args: string[]) => void;
  /** Read the current global tmux update-environment array. The default reader invokes tmux with an argv
   * array and returns variable NAMES only; injection keeps version-specific behavior deterministic in tests. */
  readTmuxUpdateEnvironment?: () => readonly string[] | undefined;
  /** Read the live pane's screen mode before handing an already-running tmux client to a fresh browser.
   * Tests inject this so they never inspect a developer's tmux server. */
  readTmuxAlternateScreen?: (sessionName: string) => boolean | undefined;
  /** Read the live pane's complete standard terminal state. A freshly attached browser did not observe the
   * DECSET sequences an already-running TUI emitted before it joined, so the mirror must restore them after
   * its tmux capture just like a native tmux mirror. */
  readTmuxTerminalState?: (sessionName: string) => TmuxTerminalState | undefined;
  /** Capture the live pane's rendered history before attaching a fresh terminal mirror. The returned payload
   * is replayed into xterm before live PTY output, so browser reconnects inherit tmux-owned history. */
  readTmuxHistorySeed?: (sessionName: string) => string | undefined;
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

/** Keep substantially more durable pane history than tmux's 2,000-line default. The browser receives a bounded
 * reconnect seed, while tmux remains the authoritative long-lived store across PWA and OTA reconnects. */
export const TMUX_HISTORY_LIMIT_LINES = 100_000;

/** cmux uses an ANSI `capture-pane -p -e -S ...` seed for newly mounted mirrors. Twenty thousand rows stays
 * comfortably below the terminal WebSocket's bounded output budget at ordinary terminal widths while making
 * long coding-agent transcripts available immediately after reconnect. */
export const TMUX_RECONNECT_HISTORY_LINES = 20_000;
const MAX_TMUX_HISTORY_SEED_BYTES = 12 * 1024 * 1024;

export interface TmuxTerminalState {
  alternate: boolean;
  cursorX?: number;
  cursorY?: number;
  scrollRegionUpper?: number;
  scrollRegionLower?: number;
  paneHeight?: number;
  cursor: boolean;
  insert: boolean;
  keypadCursor: boolean;
  keypad: boolean;
  wrap: boolean;
  origin: boolean;
  mouseAll: boolean;
  mouseButton: boolean;
  mouseStandard: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
}

const TMUX_TERMINAL_STATE_FORMAT = [
  "alternate_on=#{alternate_on}",
  "cursor_x=#{cursor_x}",
  "cursor_y=#{cursor_y}",
  "scroll_region_upper=#{scroll_region_upper}",
  "scroll_region_lower=#{scroll_region_lower}",
  "cursor_flag=#{cursor_flag}",
  "insert_flag=#{insert_flag}",
  "keypad_cursor_flag=#{keypad_cursor_flag}",
  "keypad_flag=#{keypad_flag}",
  "wrap_flag=#{wrap_flag}",
  "origin_flag=#{origin_flag}",
  "pane_height=#{pane_height}",
  "mouse_all_flag=#{mouse_all_flag}",
  "mouse_button_flag=#{mouse_button_flag}",
  "mouse_standard_flag=#{mouse_standard_flag}",
  "mouse_sgr_flag=#{mouse_sgr_flag}",
  "mouse_utf8_flag=#{mouse_utf8_flag}",
].join(",");

/** Parse tmux's fixed, numeric `display-message` response without trusting it as terminal output. Values are
 * bounded before later one-based cursor/region arithmetic, following cmux's native tmux mirror. */
export function parseTmuxTerminalState(line: string): TmuxTerminalState | undefined {
  const fields = new Map<string, string>();
  for (const pair of line.trim().split(",")) {
    const split = pair.indexOf("=");
    if (split <= 0) continue;
    fields.set(pair.slice(0, split), pair.slice(split + 1));
  }
  const alternateValue = fields.get("alternate_on");
  if (alternateValue !== "0" && alternateValue !== "1") return undefined;
  const on = (name: string): boolean => fields.get(name) === "1";
  const num = (name: string): number | undefined => {
    const raw = fields.get(name);
    if (raw === undefined || !/^\d{1,5}$/u.test(raw)) return undefined;
    const value = Number(raw);
    return value <= 65_535 ? value : undefined;
  };
  return {
    alternate: alternateValue === "1",
    cursorX: num("cursor_x"),
    cursorY: num("cursor_y"),
    scrollRegionUpper: num("scroll_region_upper"),
    scrollRegionLower: num("scroll_region_lower"),
    paneHeight: num("pane_height"),
    cursor: on("cursor_flag"),
    insert: on("insert_flag"),
    keypadCursor: on("keypad_cursor_flag"),
    keypad: on("keypad_flag"),
    wrap: on("wrap_flag"),
    origin: on("origin_flag"),
    mouseAll: on("mouse_all_flag"),
    mouseButton: on("mouse_button_flag"),
    mouseStandard: on("mouse_standard_flag"),
    mouseSgr: on("mouse_sgr_flag"),
    mouseUtf8: on("mouse_utf8_flag"),
  };
}

/** Restore the standard terminal modes that an already-running pane emitted before this mirror attached.
 * Mouse tracking deliberately uses tmux's concrete flags: `mouse_any_flag` is only an aggregate OR flag.
 * Cursor placement is last because DECSTBM and DECOM both home it. */
export function tmuxTerminalStateSequence(state: TmuxTerminalState): string {
  let sequence = "\x1b[m";
  const upper = state.scrollRegionUpper;
  const lower = state.scrollRegionLower;
  let restrictedRegion = false;
  if (upper !== undefined && lower !== undefined && lower >= upper) {
    const fullWindow = upper === 0 && state.paneHeight !== undefined && lower === state.paneHeight - 1;
    if (!fullWindow) {
      sequence += `\x1b[${upper + 1};${lower + 1}r`;
      restrictedRegion = true;
    }
  }
  sequence += state.wrap ? "\x1b[?7h" : "\x1b[?7l";
  sequence += state.cursor ? "\x1b[?25h" : "\x1b[?25l";
  sequence += state.insert ? "\x1b[4h" : "\x1b[4l";
  sequence += state.keypadCursor ? "\x1b[?1h" : "\x1b[?1l";
  sequence += state.keypad ? "\x1b=" : "\x1b>";
  // A reused browser surface may retain a mode from the previous pane. Reset every concrete tracking and
  // encoding mode before enabling the authoritative state from tmux.
  sequence += "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l";
  if (state.mouseAll) sequence += "\x1b[?1003h";
  else if (state.mouseButton) sequence += "\x1b[?1002h";
  else if (state.mouseStandard) sequence += "\x1b[?1000h";
  if (state.mouseSgr) sequence += "\x1b[?1006h";
  else if (state.mouseUtf8) sequence += "\x1b[?1005h";
  sequence += state.origin ? "\x1b[?6h" : "\x1b[?6l";
  if (state.cursorX !== undefined && state.cursorY !== undefined) {
    const row = state.origin && restrictedRegion ? Math.max(0, state.cursorY - (upper ?? 0)) : state.cursorY;
    sequence += `\x1b[${row + 1};${state.cursorX + 1}H`;
  }
  return sequence;
}

/** Raise the limit on an already-running dedicated tmux server during RoamCode boot. This is intentionally
 * best-effort: with no live tmux server there is nothing to migrate, and the normal creation chain applies the
 * same option before the first new session. Existing panes adopt the larger limit without being restarted. */
export function configureTmuxHistoryLimit(tmuxBin = "tmux", tmuxSocket = TMUX_SOCKET): boolean {
  try {
    return (
      spawnSync(tmuxBin, ["-L", tmuxSocket, "set-option", "-g", "history-limit", String(TMUX_HISTORY_LIMIT_LINES)], {
        stdio: "ignore",
        timeout: 1_000,
      }).status === 0
    );
  } catch {
    return false;
  }
}

/** The tmux session name for a roamcode session id. Stable so attach/kill always target the same one. */
export function tmuxSessionName(id: string): string {
  return `rc-${id}`;
}

const ROAMCODE_TMUX_ENVIRONMENT = ["RC_BASE_URL", "RC_SESSION_ID", "RC_TOKEN", "RC_TOKEN_FILE"] as const;

// tmux's compiled default. Used only when no dedicated server exists yet (or the read fails), so the first
// RoamCode session retains tmux's normal display/auth forwarding instead of starting from an empty list.
const DEFAULT_TMUX_UPDATE_ENVIRONMENT = [
  "DISPLAY",
  "KRB5CCNAME",
  "MSYSTEM",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_CONNECTION",
  "WINDOWID",
  "XAUTHORITY",
] as const;

function readTmuxUpdateEnvironment(tmuxBin: string, tmuxSocket: string): string[] | undefined {
  try {
    const result = spawnSync(tmuxBin, ["-L", tmuxSocket, "show-options", "-gv", "update-environment"], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return result.stdout
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function readTmuxAlternateScreen(tmuxBin: string, tmuxSocket: string, sessionName: string): boolean | undefined {
  try {
    const result = spawnSync(
      tmuxBin,
      ["-L", tmuxSocket, "display-message", "-p", "-t", sessionName, "#{alternate_on}"],
      { encoding: "utf8", timeout: 1_000 },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    const value = result.stdout.trim();
    return value === "1" ? true : value === "0" ? false : undefined;
  } catch {
    return undefined;
  }
}

/** Read the pane's standard terminal state through tmux formats. This is generic protocol state: it makes the
 * same handoff for every shell, pager and full-screen TUI without inspecting a process name or pane content. */
export function readTmuxTerminalState(
  tmuxBin: string,
  tmuxSocket: string,
  sessionName: string,
): TmuxTerminalState | undefined {
  try {
    const result = spawnSync(
      tmuxBin,
      ["-L", tmuxSocket, "display-message", "-p", "-t", sessionName, "-F", TMUX_TERMINAL_STATE_FORMAT],
      { encoding: "utf8", timeout: 1_000 },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return parseTmuxTerminalState(result.stdout);
  } catch {
    return undefined;
  }
}

/** Capture tmux's rendered history as an ANSI replay for a fresh xterm mirror. Like cmux's remote-tmux seed,
 * rows are kept as faithful visual rows (`-J` is deliberately absent), the visible screen is cleared without
 * erasing scrollback, and LF row separators become CRLF so every captured row starts in column zero. */
export function captureTmuxHistorySeed(tmuxBin: string, tmuxSocket: string, sessionName: string): string | undefined {
  try {
    const result = spawnSync(
      tmuxBin,
      ["-L", tmuxSocket, "capture-pane", "-p", "-e", "-S", `-${TMUX_RECONNECT_HISTORY_LINES}`, "-t", sessionName],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: MAX_TMUX_HISTORY_SEED_BYTES,
      },
    );
    if (result.status !== 0 || typeof result.stdout !== "string" || result.stdout.length === 0) return undefined;
    let rows = result.stdout.replace(/\r\n/gu, "\n");
    if (rows.endsWith("\n")) rows = rows.slice(0, -1);
    return `\x1b[H\x1b[2J${rows.replace(/\n/gu, "\r\n")}`;
  } catch {
    return undefined;
  }
}

function normalizeTmuxUpdateEnvironment(current: readonly string[] | undefined): string[] {
  const required = new Set<string>(ROAMCODE_TMUX_ENVIRONMENT);
  return [...(current ?? DEFAULT_TMUX_UPDATE_ENVIRONMENT).filter((name) => !required.has(name)), ...required];
}

/** Server-wide tmux options that make the embedded session behave like a plain, transparent terminal rather
 *  than a visible tmux: NO status bar (it stole a row and made the TUI look shifted), instant escape-time (the
 *  500ms default mangled Esc-prefixed sequences = arrow/alt keys), mouse + focus + clipboard passthrough, and
 *  a 256-color terminfo. Set as ONE chained command BEFORE `new-session` so claude renders full-height from
 *  its first frame (no status-bar reflow). Applied on our dedicated socket, so they never affect the user's tmux. */
function tmuxConfigChain(updateEnvironment: readonly string[]): string[] {
  const sets: Array<[scope: string, name: string, value: string]> = [
    ["-g", "status", "off"],
    ["-s", "escape-time", "0"],
    ["-g", "history-limit", String(TMUX_HISTORY_LIMIT_LINES)],
    // Keep the server default OFF; Codex enables mouse history on its own session immediately before attach.
    // This preserves Claude's current wheel and plain drag-to-select behavior exactly as-is.
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
    // RC_* environment and Codex MCP can target the wrong RoamCode session. The list was read and normalized
    // in Node because tmux 3.4 cannot expand this array through #{update-environment}. Only variable NAMES
    // enter argv; token values remain solely in the PTY client's environment.
    "set-option",
    "-g",
    "update-environment",
    updateEnvironment.join(" "),
    ";",
    // tmux's stock first WheelUp only enters copy mode; it does not move. Enter AND scroll on that same
    // gesture so Codex feels like a normal scrollable conversation from the first wheel/trackpad movement.
    // Alternate-screen apps (Claude) and apps that request mouse input continue receiving the event.
    "bind-key",
    "-n",
    "WheelUpPane",
    "if-shell",
    "-F",
    "#{||:#{alternate_on},#{mouse_any_flag}}",
    "send-keys -M",
    "copy-mode -e; send-keys -X -N 5 scroll-up",
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
  private readonly readTmuxUpdateEnvironment: () => readonly string[] | undefined;
  private readonly readTmuxAlternateScreen: (sessionName: string) => boolean | undefined;
  private readonly readTmuxTerminalState: (sessionName: string) => TmuxTerminalState | undefined;
  private readonly readTmuxHistorySeed: (sessionName: string) => string | undefined;

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
    this.readTmuxUpdateEnvironment =
      opts.readTmuxUpdateEnvironment ?? (() => readTmuxUpdateEnvironment(this.tmuxBin, this.tmuxSocket));
    // An injected PTY means an isolated unit/integration fixture. Do not let a read-only screen-mode probe
    // escape that fixture into the developer's real tmux server unless the test explicitly supplied one.
    this.readTmuxAlternateScreen =
      opts.readTmuxAlternateScreen ??
      (opts.ptySpawn
        ? () => undefined
        : (sessionName) => readTmuxAlternateScreen(this.tmuxBin, this.tmuxSocket, sessionName));
    this.readTmuxTerminalState =
      opts.readTmuxTerminalState ??
      (opts.ptySpawn
        ? () => undefined
        : (sessionName) => readTmuxTerminalState(this.tmuxBin, this.tmuxSocket, sessionName));
    // Apply the same isolation rule to history capture: a fake PTY fixture must never read the developer's
    // production tmux socket unless the test supplied an explicit, isolated capture implementation.
    this.readTmuxHistorySeed =
      opts.readTmuxHistorySeed ??
      (opts.ptySpawn
        ? () => undefined
        : (sessionName) => captureTmuxHistorySeed(this.tmuxBin, this.tmuxSocket, sessionName));
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
    const providerCommand = this.opts.attachOnly
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
    const terminalCommand = this.opts.enableMouseHistory
      ? [
          ...(this.opts.attachOnly ? [] : [...providerCommand.slice(0, 2), "-d", ...providerCommand.slice(2), ";"]),
          "set-option",
          "-t",
          this.tmuxName,
          "mouse",
          "on",
          ";",
          "attach-session",
          "-t",
          this.tmuxName,
        ]
      : providerCommand;
    const updateEnvironment = normalizeTmuxUpdateEnvironment(this.readTmuxUpdateEnvironment());
    const args = ["-L", this.tmuxSocket, "-u", ...tmuxConfigChain(updateEnvironment), ...terminalCommand];
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

  /** The live tmux pane, not the provider identity, decides which terminal buffer a fresh client must use. */
  usesAlternateScreen(): boolean | undefined {
    return this.readTmuxTerminalState(this.tmuxName)?.alternate ?? this.readTmuxAlternateScreen(this.tmuxName);
  }

  /** Hand a fresh browser the live pane's standard DEC state before tmux repaints it. */
  terminalStateSeed(fallbackAlternate = false): string {
    const state = this.readTmuxTerminalState(this.tmuxName);
    const alternate = state?.alternate ?? this.readTmuxAlternateScreen(this.tmuxName) ?? fallbackAlternate;
    return `${alternate ? "\x1b[?1049h" : "\x1b[?1049l"}${state ? tmuxTerminalStateSequence(state) : ""}`;
  }

  /** Seed a fresh browser terminal with the durable tmux history before the live attach redraw begins. */
  historySeed(fallbackAlternate = false): string | undefined {
    const captured = this.readTmuxHistorySeed(this.tmuxName);
    if (!captured) return undefined;
    const state = this.readTmuxTerminalState(this.tmuxName);
    const alternate = state?.alternate ?? this.readTmuxAlternateScreen(this.tmuxName) ?? fallbackAlternate;
    return `${alternate ? "\x1b[?1049h" : "\x1b[?1049l"}${captured}${state ? tmuxTerminalStateSequence(state) : ""}`;
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
  if (!ensureNodePtySpawnHelperExecutable()) throw new Error("node-pty spawn helper is not executable");
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
