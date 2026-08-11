import { isNewerMajorMinor, type PaneStatus } from "../pane-status.js";
import type {
  ProviderPaneClassification,
  ProviderRuntimeMetadata,
  ProviderRuntimeSignal,
  ProviderRuntimeSignalParser,
} from "./types.js";

export const CODEX_OSC_MAX_CARRY = 8 * 1024;
export const CODEX_CLASSIFIER_TESTED_UP_TO = "0.144";

const OSC_START = "\u001b]";
const OSC_9_START = "\u001b]9;";
const ST = "\u001b\\";

export interface CodexOscParser extends ProviderRuntimeSignalParser {
  readonly bufferedLength: number;
}

function signalForPayload(payload: string): ProviderRuntimeSignal | undefined {
  if (
    payload.startsWith("Approval requested: ") ||
    payload.startsWith("Codex wants to edit ") ||
    payload.startsWith("Approval requested by ") ||
    payload.startsWith("Plan mode prompt: ")
  ) {
    return { type: "blocked" };
  }
  return payload.length > 0 ? { type: "idle" } : undefined;
}

function terminatorAt(input: string, from: number): { index: number; width: number } | undefined {
  const bel = input.indexOf("\u0007", from);
  const st = input.indexOf(ST, from);
  if (bel === -1 && st === -1) return undefined;
  if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, width: 1 };
  return { index: st, width: 2 };
}

export function createCodexOscParser(): CodexOscParser {
  let carry = "";

  return {
    get bufferedLength() {
      return carry.length;
    },
    push(chunk) {
      const input = carry + chunk;
      carry = "";
      const signals: ProviderRuntimeSignal[] = [];
      let cursor = 0;

      while (cursor < input.length) {
        const start = input.indexOf("\u001b", cursor);
        if (start === -1) break;
        if (start === input.length - 1) {
          carry = "\u001b";
          break;
        }
        if (!input.startsWith(OSC_START, start)) {
          cursor = start + 1;
          continue;
        }
        if (input.length < start + OSC_9_START.length) {
          carry = input.slice(start);
          break;
        }
        if (!input.startsWith(OSC_9_START, start)) {
          cursor = start + OSC_START.length;
          continue;
        }

        const payloadStart = start + OSC_9_START.length;
        const terminator = terminatorAt(input, payloadStart);
        if (!terminator) {
          const pending = input.slice(start);
          carry = pending.length <= CODEX_OSC_MAX_CARRY ? pending : "";
          break;
        }

        const frameLength = terminator.index + terminator.width - start;
        if (frameLength <= CODEX_OSC_MAX_CARRY) {
          const signal = signalForPayload(input.slice(payloadStart, terminator.index));
          if (signal) signals.push(signal);
        }
        cursor = terminator.index + terminator.width;
      }

      return signals;
    },
  };
}

export function parseCodexOscNotifications(input: string): ProviderRuntimeSignal[] {
  return createCodexOscParser().push(input);
}

function detectedCodex(
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

function afterLastCodexPrompt(pane: string): string {
  const lines = pane.split(/\r?\n/u);
  let index = -1;
  for (let current = lines.length - 1; current >= 0; current -= 1) {
    const line = lines[current]!;
    if (line !== "›" && !line.startsWith("› ")) continue;
    index = current;
    break;
  }
  return lines.slice(index + 1).join("\n");
}

/** Codex state from the same provider-owned signals its current TUI exposes: OSC title spinner/action state,
 * current prompt-block forms, and the pinned bottom working row. Conversation scrollback is deliberately
 * excluded from the strong blocker/working regions. */
export function classifyCodexPaneState(pane: string, title = ""): ProviderPaneClassification {
  const tail = pane.split(/\r?\n/u).slice(-28).join("\n");
  const bottom3 = tail
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .slice(-3)
    .join("\n");
  const livePrompt = afterLastCodexPrompt(tail);

  if (/Action Required/iu.test(title)) return detectedCodex("blocked", "blocked", "codex_osc_title_blocked");
  // Herdr's current Codex manifest gives the live title spinner priority over transcript/history overlays.
  if (/(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u.test(title)) {
    return detectedCodex("working", "working", "codex_osc_title_working");
  }
  if (
    /↑\/?↓ to scroll/iu.test(livePrompt) &&
    /pgup\/pgdn to/iu.test(livePrompt) &&
    /home\/end to jump/iu.test(livePrompt) &&
    /q to quit/iu.test(livePrompt) &&
    /esc(?:\/←)? to edit prev/iu.test(livePrompt)
  ) {
    return detectedCodex("idle", undefined, "codex_transcript_viewer", true);
  }
  if (
    /^> You are in [^\r\n]+/u.test(tail) &&
    /Do\s+you\s+trust\s+the\s+contents\s+of\s+this\s+directory\?/isu.test(tail)
  ) {
    return detectedCodex("blocked", "blocked", "codex_trust_directory");
  }
  if (
    /(?:press enter to confirm or esc to cancel|enter to submit answer|enter to submit all|allow command\?)/iu.test(
      livePrompt,
    )
  ) {
    return detectedCodex("blocked", "blocked", "codex_live_blocker");
  }
  if (/(?:Would you like to run the following command|Do you want to allow|\[y\/n\]|yes \(y\))/iu.test(livePrompt)) {
    return detectedCodex("blocked", "blocked", "codex_approval_fallback");
  }
  if (/^[•◦]\s+Working \([^)]*esc to interrupt\)(?: · .*)?$/imu.test(bottom3)) {
    return detectedCodex("working", "working", "codex_screen_working");
  }

  if (title.trim() && !/(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)/u.test(title) && !/Action Required/iu.test(title)) {
    return detectedCodex("idle", "idle", "codex_osc_title_idle");
  }
  if (/^›(?:\s|$)/mu.test(tail)) return detectedCodex("idle", "idle", "codex_live_prompt");
  return detectedCodex("idle", undefined, "codex_known_agent_idle_fallback");
}

export function classifyCodexPane(pane: string): PaneStatus {
  return classifyCodexPaneState(pane).activity;
}

const RUNTIME_TOKEN = "[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}";
const EFFORT_TOKEN = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";

/**
 * Read Codex's LIVE model + reasoning level from the pinned bottom status row. Unlike launch options, this
 * changes immediately when the user switches reasoning inside the TUI. Only the final non-empty row is
 * considered, so conversation text that happens to mention a model/effort pair cannot rewrite metadata.
 *
 * Supported real Codex layouts:
 *   gpt-5.6-sol xhigh · ~/Developer/remote-coder
 *   gpt-5.6 · high · 91% left
 */
export function parseCodexRuntimeMetadata(pane: string): ProviderRuntimeMetadata | undefined {
  const line = pane
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;

  const current = new RegExp(`^(${RUNTIME_TOKEN})\\s+(${EFFORT_TOKEN})\\s+·\\s+(?:~/|/).+$`).exec(line);
  if (current) return { model: current[1], effort: current[2] };

  const legacy = new RegExp(`^(${RUNTIME_TOKEN})\\s+·\\s+(${EFFORT_TOKEN})\\s+·\\s+.+$`).exec(line);
  return legacy ? { model: legacy[1], effort: legacy[2] } : undefined;
}

export function codexClassifierVersionWarning(codexVersion: string | undefined): string | undefined {
  if (!codexVersion || !isNewerMajorMinor(codexVersion, CODEX_CLASSIFIER_TESTED_UP_TO)) return undefined;
  return (
    `Codex pane-status markers were verified against Codex <=${CODEX_CLASSIFIER_TESTED_UP_TO}; ` +
    `current is ${codexVersion} — verify rail statuses after this upgrade`
  );
}
