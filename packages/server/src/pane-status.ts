import { spawn } from "node:child_process";
import type { ProviderPaneClassification } from "./providers/types.js";

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
 * Evidence priority follows the provider UI: its live OSC spinner wins first, then current blockers/working
 * chrome, then explicit idle chrome, and finally a conservative idle fallback.
 */
function detected(
  activity: PaneStatus,
  signal: "working" | "blocked" | "idle" | undefined,
  rule: string,
  skipStateUpdate = false,
): ProviderPaneClassification {
  return {
    activity,
    visibleWorking: signal === "working",
    visibleBlocked: signal === "blocked",
    visibleIdle: signal === "idle",
    ...(skipStateUpdate ? { skipStateUpdate: true } : {}),
    rule,
  };
}

function bottomNonEmptyLines(pane: string, count: number): string {
  const lines = pane.split(/\r?\n/u);
  const selected: string[] = [];
  for (let index = lines.length - 1; index >= 0 && selected.length < count; index -= 1) {
    if (lines[index]!.trim()) selected.unshift(lines[index]!);
  }
  return selected.join("\n");
}

function horizontalRule(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && /^─+$/u.test(trimmed);
}

function afterLastHorizontalRule(pane: string): string {
  const lines = pane.split(/\r?\n/u);
  let index = -1;
  for (let current = lines.length - 1; current >= 0; current -= 1) {
    if (!horizontalRule(lines[current]!)) continue;
    index = current;
    break;
  }
  return lines.slice(index + 1).join("\n");
}

function claudePromptVisible(pane: string): boolean {
  const live = bottomNonEmptyLines(pane, 8);
  return (
    /^\s*❯(?:\s|$)/mu.test(live) &&
    !/enter to (?:select|confirm)|esc to cancel|arrow keys to navigate|↑\/?↓/iu.test(live)
  );
}

/**
 * Claude Code state from current, provider-owned screen regions plus its OSC pane title. This follows the
 * same shape used by Herdr's live screen manifest: blocker forms are scoped to the current form/prompt,
 * transcript viewers freeze the previous state, and the title/live chrome supplies explicit working/idle
 * evidence. The older token-flow markers remain as a verified fallback for active background agents.
 */
export function classifyClaudePane(pane: string, title = ""): ProviderPaneClassification {
  const recent = pane.split(/\r?\n/u).slice(-28).join("\n");
  const liveForm = afterLastHorizontalRule(recent);
  const bottom5 = bottomNonEmptyLines(recent, 5);
  const bottom3 = bottomNonEmptyLines(recent, 3);

  // Priority follows Herdr's current Claude manifest. The OSC spinner is the strongest live signal and must
  // outrank an expanded transcript whose visible text is historical.
  if (/^[\u2800-\u28ff] /u.test(title)) return detected("working", "working", "claude_osc_title_working");

  if (
    /showing detailed transcript/iu.test(bottom3) &&
    /(?:ctrl\+[oe].*(?:toggle|show all|collapse)|↑\/?↓\s*scroll|\? for shortcuts)/iu.test(bottom3)
  ) {
    return detected("idle", undefined, "claude_transcript_viewer", true);
  }

  const formNavigation = /(?:tab\/arrow keys|arrow keys|arrows|↑\/?↓|↑↓) to navigate/iu.test(liveForm);
  if (
    /esc to cancel/iu.test(liveForm) &&
    (/enter to confirm/iu.test(liveForm) || (/enter to select/iu.test(liveForm) && formNavigation))
  ) {
    return detected("blocked", "blocked", "claude_live_blocked_form");
  }
  if (/run a dynamic workflow\?/iu.test(recent) && /esc to cancel/iu.test(recent)) {
    return detected("blocked", "blocked", "claude_dynamic_workflow_prompt");
  }
  if (
    /do you want to proceed\?/iu.test(liveForm) &&
    /(?:^\s*❯?\s*1\.\s*yes\b|^\s*2\.\s*(?:yes|no)\b|tab to amend|ctrl\+e to explain)/imu.test(liveForm)
  ) {
    return detected("blocked", "blocked", "claude_permission_prompt");
  }
  if (
    /would you like to proceed\?/iu.test(liveForm) &&
    /(?:^\s*❯?\s*1\.\s*yes\b|^\s*[23]\.\s*(?:yes|no)\b)/imu.test(liveForm)
  ) {
    return detected("blocked", "blocked", "claude_plan_prompt");
  }
  if (
    /(?:waiting for permission|do you want to allow this connection\?|review your answers|skip interview and plan immediately)/iu.test(
      liveForm,
    )
  ) {
    return detected("blocked", "blocked", "claude_legacy_blocker");
  }

  if (/^\s*\/btw(?:\s|$)/mu.test(bottom5) && /esc to close\s*$/imu.test(bottom5)) {
    return detected("working", "working", "claude_btw_overlay_working");
  }
  if (/…[^\n]*↓\s*[\d.]+\s*[kKmM]?\s*tokens?\b/u.test(recent)) {
    return detected("working", "working", "claude_live_token_flow");
  }
  if (/…\s*\(\s*\d+\s*[ms]\b/u.test(recent)) {
    return detected("working", "working", "claude_spinner_timer");
  }
  if (/\bWaiting for\b[\s\S]{0,80}?\bto finish\b/iu.test(recent)) {
    return detected("working", "working", "claude_waiting_for_worker");
  }
  if (/\besc to interrupt\b/iu.test(recent)) {
    return detected("working", "working", "claude_interruptible_work");
  }

  if (
    /select model/iu.test(recent) &&
    /enter to set as default/iu.test(recent) &&
    /esc to cancel/iu.test(recent) &&
    !/do you want to proceed\?|enter to select/iu.test(recent)
  ) {
    return detected("idle", undefined, "claude_model_picker", true);
  }

  if (/^✳ /u.test(title)) return detected("idle", "idle", "claude_osc_title_idle");
  if (claudePromptVisible(recent)) return detected("idle", "idle", "claude_live_prompt");
  return detected("idle", undefined, "claude_known_agent_idle_fallback");
}

export function classifyPaneStatus(pane: string): PaneStatus {
  return classifyClaudePane(pane).activity;
}

/** How capturePane locates a session's tmux pane. */
export interface CaptureOptions {
  tmuxBin?: string;
  socket: string;
  sessionName: string;
  timeoutMs?: number;
}

export interface PaneTitleCaptureOptions {
  tmuxBin?: string;
  socket: string;
  timeoutMs?: number;
}

/** Parse `session:title` rows emitted by the dedicated RoamCode tmux server. Session ids generated by
 * RoamCode cannot contain `:`, while provider titles may, so only the first separator is structural. */
export function parsePaneTitles(value: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const sessionName = line.slice(0, separator);
    const title = line
      .slice(separator + 1)
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "")
      .slice(0, 1024);
    titles.set(sessionName, title);
  }
  return titles;
}

/** One read-only tmux inventory per monitor sweep supplies OSC-updated pane titles for every session. */
export function capturePaneTitles(opts: PaneTitleCaptureOptions): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(parsePaneTitles(out));
    };
    try {
      const process = spawn(
        opts.tmuxBin ?? "tmux",
        ["-L", opts.socket, "list-panes", "-a", "-F", "#{session_name}:#{pane_title}"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      process.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.length > 256 * 1024) {
          try {
            process.kill();
          } catch {
            /* already gone */
          }
          finish();
        }
      });
      process.on("error", finish);
      process.on("close", finish);
      const timeout = setTimeout(() => {
        try {
          process.kill();
        } catch {
          /* already gone */
        }
        finish();
      }, opts.timeoutMs ?? 1_500);
      timeout.unref?.();
    } catch {
      finish();
    }
  });
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
