import { spawn } from "node:child_process";

export type PaneStatus = "working" | "blocked" | "idle";

/**
 * The newest Claude Code MAJOR.MINOR the classifier's markers below were VERIFIED against on a live box.
 * The whole classifier is tied to Claude Code's ENGLISH TUI strings — the load-bearing markers are:
 *   - "Do you want to proceed" / "Would you like to proceed"   (blocked — permission/plan prompts)
 *   - the gerund ellipsis "…" + "↓ <n>k tokens" live counter    (working — main spinner + live agents)
 *   - a "…(<n>s"-style parenthesised spinner timer               (working — pre-token-flow window)
 *   - "Waiting for … to finish" / "esc to interrupt"             (working)
 * A NEWER claude may reword any of these and silently degrade every rail status to "idle", so boot logs a
 * one-time warning (see start.ts) when the installed claude's MAJOR.MINOR exceeds this. Bump it after
 * re-verifying the markers against a newer claude.
 */
export const CLASSIFIER_TESTED_UP_TO = "2.1";

/**
 * True iff `current`'s MAJOR.MINOR is strictly NEWER than `testedUpTo`'s. Patch versions are ignored — a
 * patch release doesn't reword the TUI. Unparseable input (either side) → false, so a weird version string
 * can never produce a spurious warning. Pure.
 */
export function isNewerMajorMinor(current: string, testedUpTo: string): boolean {
  const parse = (v: string): [number, number] | undefined => {
    const m = /(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : undefined;
  };
  const cur = parse(current);
  const tested = parse(testedUpTo);
  if (!cur || !tested) return false; // can't decide → never warn spuriously
  if (cur[0] !== tested[0]) return cur[0] > tested[0];
  return cur[1] > tested[1];
}

/**
 * The one-line boot warning when the RUNNING claude is newer than the classifier was verified against —
 * or undefined when there is nothing to warn about (older/equal/unknown version). Pure so it's testable;
 * start.ts logs it once via console.warn and NEVER throws (a version bump must not affect boot).
 */
export function classifierVersionWarning(claudeVersion: string | undefined): string | undefined {
  if (!claudeVersion || !isNewerMajorMinor(claudeVersion, CLASSIFIER_TESTED_UP_TO)) return undefined;
  return (
    `pane-status markers were verified against claude <=${CLASSIFIER_TESTED_UP_TO}; ` +
    `current is ${claudeVersion} — verify rail statuses after this upgrade`
  );
}

/**
 * Classify a session's live ACTIVITY from its RENDERED tmux pane (`capture-pane -p` — the CURRENT screen, not
 * scrollback). UNIVERSAL: works for any running session regardless of how claude was spawned (no per-session
 * hooks needed), and works while the browser is DETACHED (it reads the tmux session directly). Grounded in
 * Claude Code's real output — see pane-status.test.ts for captured samples.
 *
 *   working → something is actively generating. The strongest tell is a LIVE token-flow counter "↓ 216.5k
 *             tokens" — it appears on the MAIN spinner ("Schlepping… (1m 17s · ↓ 2.1k tokens)") AND on an
 *             ACTIVE background agent ("⏺ general-purpose  Listing f… 24m 23s · ↓ 216.5k tokens"), and is GONE
 *             the moment a turn finishes ("Baked for 23m 15s"). So a session whose MAIN loop is at the prompt
 *             but has agents still developing in the background reads "working" — NOT idle (the user's
 *             explicit correction). Also: a spinner's parenthesised timer, "Waiting for … to finish", or
 *             "esc to interrupt".
 *   blocked → claude is WAITING ON A DECISION FROM YOU: a permission prompt ("Do you want to proceed?"), a
 *             plan-mode approval ("Would you like to proceed?"). This is the ONLY state that earns the loud
 *             "needs you" — so it must stay RARE + real; that's why it's just the explicit-prompt phrasings.
 *   idle    → none of the above: claude finished a turn and is sitting at an empty prompt with nothing running
 *             and nothing to decide. A calm "your turn whenever" — NOT a loud alert.
 *
 * Order matters: blocked is checked first (a decision prompt overrides any stale spinner text), then working,
 * else idle.
 */
export function classifyPaneStatus(pane: string): PaneStatus {
  // Only look at the BOTTOM of the pane. Claude Code pins its live chrome — the spinner, the input box, the
  // status line, and the background-agent block — to the last ~dozen rows; everything above is CONVERSATION
  // SCROLLBACK. Restricting to the tail means a session whose scrollback happens to show these very marker
  // strings (e.g. one editing remote-coder's own source, or a diff mentioning "↓ … tokens" / "proceed") can't
  // be misread — only claude's actual status chrome is classified.
  const tail = pane.split("\n").slice(-22).join("\n");

  // BLOCKED — an explicit decision prompt. Kept to Claude Code's exact permission/plan phrasings so the loud
  // "needs you" it drives stays rare + trustworthy.
  if (/\bDo you want to proceed\b/i.test(tail)) return "blocked";
  if (/\bWould you like to proceed\b/i.test(tail)) return "blocked";

  // WORKING — a LIVE token-flow counter "↓ <n>k tokens" is the reliable "actively generating" signal, present
  // for BOTH the main spinner ("Schlepping… (1m 17s · ↓ 2.1k tokens)") and an active background agent
  // ("⏺ general-purpose  Listing f… 24m 23s · ↓ 216.5k tokens"). We require a GERUND ellipsis "…" on the SAME
  // line so a FINISHED thing's past-tense summary ("Done · ↓ 12k tokens") can't read as working — an active
  // worker always shows "<Gerund>… <timer> · ↓ tokens".
  if (/…[^\n]*↓\s*[\d.]+\s*[kKmM]?\s*tokens?\b/.test(tail)) return "working";
  // A spinner's parenthesised elapsed timer (covers the brief window at a turn's start before tokens flow).
  if (/…\s*\(\s*\d+\s*[ms]\b/.test(tail)) return "working";
  // Main loop blocked on a foreground agent/tool.
  if (/\bWaiting for\b[\s\S]{0,80}?\bto finish\b/i.test(tail)) return "working";
  // Interruptible generation (may be truncated to "e…" on a narrow phone pane, so it's a bonus, not the only tell).
  if (/\besc to interrupt\b/i.test(tail)) return "working";

  return "idle";
}

/** How capturePane locates a session's tmux pane. */
export interface CaptureOptions {
  tmuxBin?: string;
  socket: string;
  sessionName: string;
  timeoutMs?: number;
}

/**
 * Capture a tmux session's CURRENT pane as plain text (`capture-pane -p`, no escape sequences). READ-ONLY —
 * it never sends input or resizes, so it can NEVER disturb a live session. Best-effort: resolves "" on any
 * error/timeout and never throws. Async (non-blocking) so the activity monitor doesn't stall the event loop.
 */
export function capturePane(opts: CaptureOptions): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string): void => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const p = spawn(opts.tmuxBin ?? "tmux", ["-L", opts.socket, "capture-pane", "-p", "-t", opts.sessionName], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      p.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > 65536) {
          try {
            p.kill();
          } catch {
            /* already gone */
          }
          finish(out);
        }
      });
      p.on("error", () => finish("")); // tmux missing / spawn failed → treat as "no data"
      p.on("close", () => finish(out));
      const t = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* already gone */
        }
        finish(out);
      }, opts.timeoutMs ?? 2000);
      if (typeof t.unref === "function") t.unref();
    } catch {
      finish("");
    }
  });
}
