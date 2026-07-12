import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CODEX_CLASSIFIER_TESTED_UP_TO,
  CODEX_OSC_MAX_CARRY,
  classifyCodexPane,
  codexClassifierVersionWarning,
  createCodexOscParser,
  parseCodexOscNotifications,
} from "../../src/providers/codex-activity.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/codex/${name}-pane.txt`, import.meta.url)), "utf8");

interface TaggedPayloadFixture {
  sourceTag: string;
  payloads: {
    agentTurnPreview: string;
    agentTurnFallback: string;
    execApproval: string;
    editApproval: string;
    elicitationApproval: string;
    planModePrompt: string;
    completionMentioningApproval: string;
  };
}

const taggedPayloads = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/codex/osc9-tagged-payloads.json", import.meta.url)), "utf8"),
) as TaggedPayloadFixture;

describe("Codex OSC 9 activity notifications", () => {
  test("maps tagged approval display prefixes to blocked across direct BEL and ST frames", () => {
    expect(taggedPayloads.sourceTag).toBe("rust-v0.144.0-alpha.4");
    const { execApproval, editApproval, elicitationApproval, planModePrompt } = taggedPayloads.payloads;
    const parser = createCodexOscParser();

    expect(parser.push(`normal\u001b]9;${execApproval.slice(0, 18)}`)).toEqual([]);
    expect(parser.push(`${execApproval.slice(18)}\u0007tail`)).toEqual([{ type: "blocked" }]);
    expect(parser.push(`\u001b]9;${editApproval}\u001b\\`)).toEqual([{ type: "blocked" }]);
    expect(parser.push(`\u001b]9;${elicitationApproval}\u0007`)).toEqual([{ type: "blocked" }]);
    expect(parser.push(`\u001b]9;${planModePrompt}\u001b`)).toEqual([]);
    expect(parser.push("\\")).toEqual([{ type: "blocked" }]);
  });

  test("maps every other non-empty OSC 9 display to idle without loose approval matching", () => {
    const { agentTurnPreview, agentTurnFallback, completionMentioningApproval } = taggedPayloads.payloads;
    expect(
      parseCodexOscNotifications(
        `before\u001b]9;${agentTurnPreview}\u0007middle` +
          `\u001b]9;${agentTurnFallback}\u001b\\` +
          `\u001b]9;${completionMentioningApproval}\u0007after`,
      ),
    ).toEqual([{ type: "idle" }, { type: "idle" }, { type: "idle" }]);
  });

  test("parses tagged displays through the exact tmux DCS passthrough wrapper", () => {
    const { execApproval, agentTurnPreview } = taggedPayloads.payloads;
    const wrappedApproval = `\u001bPtmux;\u001b\u001b]9;${execApproval}\u0007\u001b\\`;
    const escapedPreview = agentTurnPreview.replaceAll("e", "e\u001b\u001b[0m");
    const wrappedPreview = `\u001bPtmux;\u001b\u001b]9;${escapedPreview}\u0007\u001b\\`;

    expect(parseCodexOscNotifications(wrappedApproval + wrappedPreview)).toEqual([
      { type: "blocked" },
      { type: "idle" },
    ]);
  });

  test("empty, normal, non-OSC9, and malformed escape sequences do not create activity", () => {
    const parser = createCodexOscParser();
    expect(parser.push("\u001b]9;\u0007")).toEqual([]);
    expect(parser.push("working text\n\u001b[31mred\u001b[0m\n")).toEqual([]);
    expect(parser.push("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toEqual([]);
    expect(parser.push("\u001b]9xApproval requested: git status\u0007")).toEqual([]);
  });

  test("bounds unterminated carry to 8 KiB and deterministically recovers", () => {
    const parser = createCodexOscParser();
    expect(parser.push("\u001b]9;" + "x".repeat(CODEX_OSC_MAX_CARRY + 1))).toEqual([]);
    expect(parser.bufferedLength).toBeLessThanOrEqual(CODEX_OSC_MAX_CARRY);
    expect(parser.push("untrusted tail\u0007")).toEqual([]);
    expect(parser.push(`\u001b]9;${taggedPayloads.payloads.execApproval}\u0007`)).toEqual([{ type: "blocked" }]);
  });

  test("recovers a later tmux-wrapped frame after an oversized malformed frame in the same chunk", () => {
    const parser = createCodexOscParser();
    const input =
      "\u001b]9;" +
      "x".repeat(CODEX_OSC_MAX_CARRY + 10) +
      "\u0007ordinary" +
      `\u001bPtmux;\u001b\u001b]9;${taggedPayloads.payloads.agentTurnFallback}\u0007\u001b\\`;
    expect(parser.push(input)).toEqual([{ type: "idle" }]);
    expect(parser.bufferedLength).toBe(0);
  });

  test("a trailing escape prefix is bounded and can complete on the next chunk", () => {
    const parser = createCodexOscParser();
    expect(parser.push("ordinary\u001b")).toEqual([]);
    expect(parser.bufferedLength).toBe(1);
    expect(parser.push(`]9;${taggedPayloads.payloads.execApproval}\u0007`)).toEqual([{ type: "blocked" }]);
  });
});

describe("Codex captured-pane fallback", () => {
  test("classifies redacted idle, approval, and working captures", () => {
    expect(classifyCodexPane(fixture("idle"))).toBe("idle");
    expect(classifyCodexPane(fixture("approval"))).toBe("blocked");
    expect(classifyCodexPane(fixture("working"))).toBe("working");
  });

  test("only reads live chrome near the bottom of the captured pane", () => {
    const scrollback = "Would you like to run the following command?\n• Working (12s • esc to interrupt)\n";
    expect(classifyCodexPane(scrollback + "ordinary output\n".repeat(30) + fixture("idle"))).toBe("idle");
  });

  test("warns only when Codex is newer than the verified classifier major/minor", () => {
    expect(CODEX_CLASSIFIER_TESTED_UP_TO).toBe("0.144");
    expect(codexClassifierVersionWarning("codex-cli 0.144.9")).toBeUndefined();
    expect(codexClassifierVersionWarning("codex-cli 0.145.0")).toMatch(/Codex.*0\.144.*0\.145\.0/i);
    expect(codexClassifierVersionWarning("unknown")).toBeUndefined();
  });
});
