/**
 * Permanent end-to-end rendering regression test.
 *
 * Replays REAL captured `claude` CLI scenarios (committed under fixtures/qa/, captured via
 * scripts/spike/qa-battery.mjs and sanitized) through BOTH production render paths — LIVE
 * (parseLine → ClaudeProcess-style dispatch → reduceFrame) and REOPEN (parseTranscript +
 * transcriptToFrames → reduceFrame) — using the real web frame-reducer and render helpers. It guards the
 * whole pipeline against the bug classes that bit us: raw-XML leaks, "[object Object]", dumped base64
 * blobs, dropped/duplicated turns, and live-vs-reopen divergence. See qa-replay.harness.ts for the
 * faithful frame reconstruction. New scenarios: capture with qa-battery.mjs, sanitize, drop both files in.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeFixture, type Issue } from "./qa-replay.harness";
import type { SessionView } from "../../web/src/store/frame-reducer";
import { parseToolResult } from "../../web/src/chat/tool-cluster";

const DIR = join(__dirname, "fixtures", "qa");

/** Each committed scenario = a `<id>.live.jsonl` + `<id>.transcript.jsonl` pair. */
function scenarios(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".live.jsonl"))
    .map((f) => f.replace(/\.live\.jsonl$/, ""))
    .sort();
}

function analyze(id: string) {
  const live = readFileSync(join(DIR, `${id}.live.jsonl`), "utf8").split("\n");
  const transcript = readFileSync(join(DIR, `${id}.transcript.jsonl`), "utf8");
  return analyzeFixture(id, live, transcript);
}

/** The compact scenario's live vs reopen command marker differs by design: the LIVE wire never carries the
 *  `<command-name>/compact</command-name>` envelope (only the `Compacted` stdout), while the transcript
 *  carries both. The real app's optimistic "/compact" bubble covers the live side. Not a drop — allowlisted. */
function isBenign(i: Issue): boolean {
  return i.fixture === "compact" && i.path === "parity" && i.kind === "turn-parity";
}

describe("QA replay — real CLI scenarios through the render pipeline", () => {
  const ids = scenarios();

  it("has committed fixtures to test", () => {
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  for (const id of ids) {
    it(`${id}: no leaks / [object Object] / base64 dumps / drops / parity gaps`, () => {
      const { issues } = analyze(id);
      const real = issues.filter((i) => !isBenign(i));
      expect(real, JSON.stringify(real, null, 2)).toEqual([]);
    });
  }

  // --- Targeted invariants locking each bug fix against the real fixture that exposed it --------------

  function someToolResult(
    view: SessionView,
    pred: (t: Extract<SessionView["turns"][number], { kind: "tool-result" }>) => boolean,
  ): boolean {
    return view.turns.some((t) => t.kind === "tool-result" && pred(t));
  }

  it("BUG-1: thinking is PRESERVED on reopen (non-empty thinking block → a thinking turn)", () => {
    const { reopen } = analyze("thinking");
    const thinking = reopen.turns.filter((t) => t.kind === "thinking");
    expect(thinking.length).toBeGreaterThan(0);
    expect((thinking[0] as { text: string }).text.length).toBeGreaterThan(0);
  });

  it("BUG-2: an image tool_result surfaces as an image, never a base64 dump", () => {
    const { reopen } = analyze("read-image");
    const withImage = reopen.turns.some(
      (t) => t.kind === "tool-result" && parseToolResult(t.content).images.length > 0,
    );
    expect(withImage).toBe(true);
  });

  it("BUG-3: a failed tool (string content) carries the error flag onto the turn", () => {
    for (const id of ["bash-error", "permission-deny"]) {
      const { live, reopen } = analyze(id);
      expect(
        someToolResult(live, (t) => t.isError === true),
        `${id} live`,
      ).toBe(true);
      expect(
        someToolResult(reopen, (t) => t.isError === true),
        `${id} reopen`,
      ).toBe(true);
    }
  });

  it("interrupt: the aborted turn ends as a calm 'stopped' result, not a red error", () => {
    const { live } = analyze("interrupt");
    const result = live.turns.find((t) => t.kind === "result") as { stopped?: boolean } | undefined;
    expect(result?.stopped).toBe(true);
  });

  it("interrupt: the synthetic '[Request interrupted by user]' notice never renders as a YOU bubble", () => {
    for (const path of ["live", "reopen"] as const) {
      const view = analyze("interrupt")[path];
      const leaked = view.turns.some(
        (t) =>
          t.kind === "user" &&
          t.blocks.some((b) => b.type === "text" && b.text.includes("[Request interrupted by user")),
      );
      expect(leaked, `${path} leaked interrupt notice`).toBe(false);
    }
  });

  it("compact: renders a clean system-note (seed) + command marker, never raw XML", () => {
    const { live, reopen } = analyze("compact");
    expect(live.turns.some((t) => t.kind === "system-note")).toBe(true);
    expect(live.turns.some((t) => t.kind === "command")).toBe(true);
    expect(reopen.turns.some((t) => t.kind === "system-note")).toBe(true);
    expect(reopen.turns.some((t) => t.kind === "command")).toBe(true);
  });
});
