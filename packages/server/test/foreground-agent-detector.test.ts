import { describe, expect, test } from "vitest";
import {
  identifyForegroundAgent,
  parsePaneProcesses,
  parseProcessSnapshot,
  splitDisplayedCommandLine,
  type ProcessSnapshotEntry,
} from "../src/foreground-agent-detector.js";

const descriptors = [
  { provider: "claude", aliases: ["claude", "claude-code"] },
  { provider: "codex", aliases: ["codex"] },
];

function process(
  pid: number,
  ppid: number,
  pgid: number,
  tpgid: number,
  command: string,
  argv: string[],
): ProcessSnapshotEntry {
  return { pid, ppid, pgid, tpgid, command, argv };
}

describe("foreground agent detector", () => {
  test("parses bounded tmux and ps snapshots", () => {
    expect(parsePaneProcesses("rc-one\t123\ninvalid\nrc-two\t456\n")).toEqual([
      { sessionName: "rc-one", panePid: 123 },
      { sessionName: "rc-two", panePid: 456 },
    ]);
    expect(parseProcessSnapshot(" 123 1 123 456 /bin/zsh /bin/zsh -l\n 456 123 456 456 codex codex\n")).toEqual([
      process(123, 1, 123, 456, "/bin/zsh", ["/bin/zsh", "-l"]),
      process(456, 123, 456, 456, "codex", ["codex"]),
    ]);
  });

  test("tokenizes quoted display argv without evaluating shell syntax", () => {
    expect(splitDisplayedCommandLine(`node "/tmp/agent tools/codex" --flag`)).toEqual([
      "node",
      "/tmp/agent tools/codex",
      "--flag",
    ]);
  });

  test("identifies direct foreground agents and ignores background children", () => {
    const snapshot = [
      process(10, 1, 10, 20, "zsh", ["zsh", "-l"]),
      process(20, 10, 20, 20, "codex", ["codex"]),
      process(30, 10, 30, 20, "claude", ["claude"]),
    ];
    expect(identifyForegroundAgent(10, snapshot, descriptors)).toEqual({ provider: "codex", pid: 20 });
  });

  test("identifies an agent that replaced the pane shell with exec", () => {
    const snapshot = [process(10, 1, 10, 10, "codex", ["codex"])];

    expect(identifyForegroundAgent(10, snapshot, descriptors)).toEqual({ provider: "codex", pid: 10 });
  });

  test.each([
    ["node", ["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex"], "codex"],
    ["bun", ["bun", "/opt/tools/claude-code"], "claude"],
    ["npx", ["npx", "--yes", "codex"], "codex"],
    ["pnpm", ["pnpm", "dlx", "codex"], "codex"],
    ["bash", ["bash", "-lc", "claude --model sonnet"], "claude"],
  ])("unwraps %s without substring matching", (command, argv, provider) => {
    const snapshot = [process(10, 1, 10, 20, "zsh", ["zsh", "-l"]), process(20, 10, 20, 20, command, argv)];
    expect(identifyForegroundAgent(10, snapshot, descriptors)).toEqual({ provider, pid: 20 });
  });

  test("does not infer an agent from arguments, helpers, or a plain shell", () => {
    for (const candidate of [
      process(20, 10, 20, 20, "node", ["node", "-e", "console.log('codex')"]),
      process(20, 10, 20, 20, "my-codex-helper", ["my-codex-helper"]),
      process(20, 10, 20, 20, "bash", ["bash", "-l"]),
      process(20, 10, 20, 20, "npm", ["npm", "run", "codex"]),
    ]) {
      const snapshot = [process(10, 1, 10, 20, "zsh", ["zsh", "-l"]), candidate];
      expect(identifyForegroundAgent(10, snapshot, descriptors)).toBeUndefined();
    }
  });
});
