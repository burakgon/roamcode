import { spawnSync } from "node:child_process";
import { TMUX_SOCKET } from "./terminal-process.js";

/** Outcome of probing the tmux server. `ok:false` means the probe FAILED in a way we can't interpret —
 *  the caller MUST NOT treat that as "zero live sessions" (doing so would prune every stored terminal). */
export interface TmuxProbe {
  ok: boolean;
  out: string;
}

function defaultRun(): TmuxProbe {
  // spawnSync is FINE here: this probe runs only at BOOT (rehydrate, before listen()), where blocking a
  // few ms is harmless and a definitive synchronous answer keeps the adopt-or-prune logic simple. Hot-path
  // tmux calls (kill-session, capture-pane) are async elsewhere.
  // MUST target the same dedicated `-L` socket the sessions were created on.
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync("tmux", ["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  } catch {
    return { ok: false, out: "" };
  }
  if (r.error) return { ok: false, out: "" };
  if (r.status === 0) return { ok: true, out: typeof r.stdout === "string" ? r.stdout : "" };
  // Exit nonzero: "no server running on <socket>" is the NORMAL empty case (no sessions exist yet) — that's a
  // definitive "zero sessions". ANY other failure is ambiguous (transient tmux error) → report not-ok so the
  // caller skips destructive pruning rather than deleting live, resumable sessions on a flaky probe.
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  if (/no server running/i.test(stderr)) return { ok: true, out: "" };
  return { ok: false, out: "" };
}

/**
 * Live tmux session names, or `undefined` when the probe could not be determined (a transient tmux error).
 * A definitive "no sessions" is `[]`; `undefined` signals the caller to NOT prune the store.
 */
export function listTmuxSessions(run: () => TmuxProbe = defaultRun): string[] | undefined {
  const { ok, out } = run();
  if (!ok) return undefined;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
