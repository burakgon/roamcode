// packages/server/test/terminal-process.test.ts
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { TerminalProcess, tmuxSessionName, TMUX_SOCKET } from "../src/terminal-process.js";

function fakePty() {
  const ee = new EventEmitter();
  const calls: { write: string[]; resize: [number, number][]; killed: number } = { write: [], resize: [], killed: 0 };
  const pty = {
    onData: (cb: (d: string) => void) => ee.on("data", cb),
    onExit: (cb: (e: { exitCode: number }) => void) => ee.on("exit", cb),
    write: (d: string) => calls.write.push(d),
    resize: (c: number, r: number) => calls.resize.push([c, r]),
    kill: () => void (calls.killed += 1),
    emitData: (d: string) => ee.emit("data", d),
    emitExit: (code: number) => ee.emit("exit", { exitCode: code }),
  };
  return { pty, calls };
}

test("start: dedicated socket, server config chained before new-session running provider executable; bridges data", () => {
  const { pty } = fakePty();
  const spawn = vi.fn(() => pty);
  const runTmux = vi.fn();
  const tp = new TerminalProcess({
    sessionId: "abc",
    cwd: "/work",
    executable: "/bin/codex",
    args: ["--model", "gpt"],
    cols: 100,
    rows: 30,
    ptySpawn: spawn as never,
    runTmux,
    env: { ...process.env, ANTHROPIC_API_KEY: "provider-owned", TMUX: "/tmp/x,1,0", TMUX_PANE: "%1" },
  });
  const seen: string[] = [];
  tp.on("data", (d) => seen.push(d));
  tp.start();

  expect(tmuxSessionName("abc")).toBe("rc-abc");
  const [file, args, opts] = spawn.mock.calls[0]!;
  expect(file).toBe("tmux");
  // Isolated socket FIRST, then `-u` to force UTF-8 (so tmux doesn't downgrade claude's block glyphs).
  expect(args.slice(0, 3)).toEqual(["-L", TMUX_SOCKET, "-u"]);
  // Server config chained BEFORE the session (so claude renders full-height from frame 1).
  const joined = args.join(" ");
  expect(joined).toContain("set-option -g status off");
  expect(joined).toContain("set-option -s escape-time 0");
  expect(joined).toContain("set-option -g remain-on-exit off"); // claude exit ENDS the session (no frozen pane)
  expect(joined).toContain("set-option -g mouse off"); // Claude/browser behavior remains the server default
  expect(joined).toContain("bind-key -n WheelUpPane"); // first wheel gesture both enters history and moves
  expect(joined).toContain("set-option -gq allow-passthrough on"); // Codex OSC 9 survives tmux; old tmux ignores it
  // new-session tail is exact.
  const ns = args.indexOf("new-session");
  expect(ns).toBeGreaterThan(0);
  expect(args.slice(ns)).toEqual([
    "new-session",
    "-A",
    "-s",
    "rc-abc",
    "-x",
    "100",
    "-y",
    "30",
    "--",
    "/bin/codex",
    "--model",
    "gpt",
  ]);
  expect(opts).toMatchObject({ name: "xterm-256color", cwd: "/work", cols: 100, rows: 30 });
  expect(opts.env.ANTHROPIC_API_KEY).toBe("provider-owned");
  expect(opts.env.TMUX).toBeUndefined();
  expect(opts.env.TMUX_PANE).toBeUndefined();
  // Config is in the spawn chain — no out-of-band runTmux call on start.
  expect(runTmux).not.toHaveBeenCalled();

  pty.emitData("hello");
  expect(seen).toEqual(["hello"]);
});

test("Codex mouse history is scoped to its session and enabled before the tmux client attaches", () => {
  const { pty } = fakePty();
  const spawn = vi.fn(() => pty);
  new TerminalProcess({
    sessionId: "codex-inline",
    cwd: "/work",
    executable: "/bin/codex",
    args: ["--no-alt-screen"],
    enableMouseHistory: true,
    ptySpawn: spawn as never,
    runTmux: () => {},
  }).start();

  const args = spawn.mock.calls[0]![1];
  expect(args.join(" ")).toContain("set-option -g mouse off");
  expect(args.slice(args.indexOf("new-session"))).toEqual([
    "new-session",
    "-A",
    "-d",
    "-s",
    "rc-codex-inline",
    "-x",
    "80",
    "-y",
    "24",
    "--",
    "/bin/codex",
    "--no-alt-screen",
    ";",
    "set-option",
    "-t",
    "rc-codex-inline",
    "mouse",
    "on",
    ";",
    "attach-session",
    "-t",
    "rc-codex-inline",
  ]);
});

test("tmux 3.4-compatible refresh preserves unrelated names and keeps secret values out of argv", () => {
  const { pty } = fakePty();
  const spawn = vi.fn(() => pty);
  const options: ConstructorParameters<typeof TerminalProcess>[0] = {
    sessionId: "env",
    cwd: "/work",
    executable: "/bin/codex",
    ptySpawn: spawn as never,
    runTmux: () => {},
    readTmuxUpdateEnvironment: () => [
      "DISPLAY",
      "RC_TOKEN",
      "OTHER_RC_TOKEN_X",
      "RC_TOKEN",
      "RC_TOKEN_FILE",
      "RC_TOKEN_FILE",
      "SSH_AUTH_SOCK",
    ],
    env: {
      PATH: "/safe/bin",
      RC_BASE_URL: "http://127.0.0.1:1234",
      RC_SESSION_ID: "session-secret-canary",
      RC_TOKEN: "token-secret-canary",
      RC_TOKEN_FILE: "/secret/token-file-canary",
      UNRELATED_PROVIDER_VALUE: "preserved",
    },
  };
  const tp = new TerminalProcess(options);

  tp.start();

  const [, args, opts] = spawn.mock.calls[0]!;
  const normalization = args.indexOf("update-environment");
  expect(args.slice(normalization - 2, normalization + 3)).toEqual([
    "set-option",
    "-g",
    "update-environment",
    "DISPLAY OTHER_RC_TOKEN_X SSH_AUTH_SOCK RC_BASE_URL RC_SESSION_ID RC_TOKEN RC_TOKEN_FILE",
    ";",
  ]);
  expect(args).not.toContain("-Fg");
  expect(args.join(" ")).not.toContain("#{update-environment}");
  expect(args.join(" ")).not.toContain("session-secret-canary");
  expect(args.join(" ")).not.toContain("token-secret-canary");
  expect(args.join(" ")).not.toContain("/secret/token-file-canary");
  expect(args.join(" ")).not.toContain("UNRELATED_PROVIDER_VALUE");
  expect(opts.env).toMatchObject({
    PATH: "/safe/bin",
    RC_SESSION_ID: "session-secret-canary",
    RC_TOKEN: "token-secret-canary",
    RC_TOKEN_FILE: "/secret/token-file-canary",
    UNRELATED_PROVIDER_VALUE: "preserved",
  });
});

test("tmux refresh falls back to tmux defaults when the dedicated server is not running yet", () => {
  const { pty } = fakePty();
  const spawn = vi.fn(() => pty);
  const options: ConstructorParameters<typeof TerminalProcess>[0] = {
    sessionId: "first-session",
    cwd: "/work",
    executable: "/bin/claude",
    ptySpawn: spawn as never,
    runTmux: () => {},
    readTmuxUpdateEnvironment: () => undefined,
  };

  new TerminalProcess(options).start();

  const args = spawn.mock.calls[0]![1];
  const normalization = args.indexOf("update-environment");
  expect(args[normalization + 1]).toBe(
    "DISPLAY KRB5CCNAME MSYSTEM SSH_ASKPASS SSH_AUTH_SOCK SSH_AGENT_PID SSH_CONNECTION WINDOWID XAUTHORITY " +
      "RC_BASE_URL RC_SESSION_ID RC_TOKEN RC_TOKEN_FILE",
  );
});

test("attachOnly adopts an existing tmux session without supplying a provider command", () => {
  const { pty } = fakePty();
  const spawn = vi.fn(() => pty);
  const tp = new TerminalProcess({
    sessionId: "adopted",
    cwd: "/work",
    executable: "/must/not/run/codex",
    args: ["resume", "--last"],
    attachOnly: true,
    ptySpawn: spawn as never,
    runTmux: () => {},
  });

  tp.start();

  const args = spawn.mock.calls[0]![1];
  expect(args.slice(args.indexOf("attach-session"))).toEqual(["attach-session", "-t", "rc-adopted"]);
  expect(args).not.toContain("new-session");
  expect(args).not.toContain("/must/not/run/codex");
  expect(args).not.toContain("--last");
});

test("write + resize forward; resize clamps; stop(kill) kills the session on the dedicated socket", () => {
  const { pty, calls } = fakePty();
  const runTmux = vi.fn();
  const tp = new TerminalProcess({
    sessionId: "z",
    cwd: "/w",
    executable: "claude",
    ptySpawn: (() => pty) as never,
    runTmux,
  });
  tp.start();
  tp.write("ls\n");
  tp.resize(80, 24);
  tp.resize(0, -5); // degenerate → clamped to >=1
  expect(calls.write).toEqual(["ls\n"]);
  expect(calls.resize).toEqual([
    [80, 24],
    [1, 1],
  ]);

  tp.stop({ kill: true });
  expect(runTmux).toHaveBeenCalledWith(["-L", TMUX_SOCKET, "kill-session", "-t", "rc-z"]);
  expect(calls.killed).toBe(1);
});

test("DEFAULT runTmux is async fire-and-forget: stop(kill) returns instantly and swallows a missing tmux bin", async () => {
  // No injected runTmux → the default (async spawn) runs. A nonexistent tmuxBin means the spawn's
  // 'error' event fires asynchronously — it must be swallowed (no throw, no unhandled error), and
  // stop() must return without waiting on the child (the old spawnSync blocked the event loop here).
  const { pty } = fakePty();
  const tp = new TerminalProcess({
    sessionId: "async-kill",
    cwd: "/w",
    executable: "claude",
    tmuxBin: "/definitely/not/a/real/tmux-bin",
    ptySpawn: (() => pty) as never,
  });
  tp.start();
  expect(() => tp.stop({ kill: true })).not.toThrow();
  // Give the async 'error' event a tick to fire — the swallow handler must keep it from becoming an
  // unhandled 'error' (which would crash this test process).
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("exit is re-emitted", () => {
  const { pty } = fakePty();
  const tp = new TerminalProcess({
    sessionId: "e",
    cwd: "/w",
    executable: "claude",
    ptySpawn: (() => pty) as never,
    runTmux: () => {},
  });
  const exits: number[] = [];
  tp.on("exit", (e) => exits.push(e.exitCode));
  tp.start();
  pty.emitExit(0);
  expect(exits).toEqual([0]);
});
