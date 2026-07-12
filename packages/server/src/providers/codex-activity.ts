import { isNewerMajorMinor, type PaneStatus } from "../pane-status.js";
import type { ProviderRuntimeSignal, ProviderRuntimeSignalParser } from "./types.js";

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

export function classifyCodexPane(pane: string): PaneStatus {
  const tail = pane.split("\n").slice(-24).join("\n");

  if (/\bWould you like to run the following command\b/i.test(tail)) return "blocked";
  if (/\bDo you want to allow\b/i.test(tail)) return "blocked";
  if (/\bPress enter to confirm or esc to cancel\b/i.test(tail)) return "blocked";

  if (/\besc to interrupt\b/i.test(tail)) return "working";
  if (/[•●]\s*(?:Working|Thinking|Running)\s*\(\s*\d+\s*[ms]\b/i.test(tail)) return "working";

  return "idle";
}

export function codexClassifierVersionWarning(codexVersion: string | undefined): string | undefined {
  if (!codexVersion || !isNewerMajorMinor(codexVersion, CODEX_CLASSIFIER_TESTED_UP_TO)) return undefined;
  return (
    `Codex pane-status markers were verified against Codex <=${CODEX_CLASSIFIER_TESTED_UP_TO}; ` +
    `current is ${codexVersion} — verify rail statuses after this upgrade`
  );
}
