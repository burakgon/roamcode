import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureNodePtySpawnHelperExecutable } from "./node-pty-runtime.js";
const require = createRequire(import.meta.url);

function tmuxOnPath(): boolean {
  // spawnSync is FINE here: this runs exactly once, at BOOT (createServer's terminalAvailable probe),
  // before any client is connected — there is no event loop latency to protect yet. Hot-path tmux calls
  // (kill-session, capture-pane) are async elsewhere.
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function ptyLoads(): boolean {
  try {
    const entry = require.resolve("node-pty");
    if (!ensureNodePtySpawnHelperExecutable(() => entry)) return false;
    require("node-pty");
    return true;
  } catch {
    return false;
  }
}

/** Terminal mode needs BOTH a tmux binary and a loadable node-pty. Injectable for tests. */
export function detectTerminalSupport(deps: { hasTmux?: () => boolean; hasPty?: () => boolean } = {}): boolean {
  return (deps.hasTmux ?? tmuxOnPath)() && (deps.hasPty ?? ptyLoads)();
}
