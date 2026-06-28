import type { TurnItem } from "../store/frame-reducer";
import type { ContentBlock } from "../types/server";
import { stripAnsi } from "./ansi";
import { parseToolResult, summarizeToolInput } from "./tool-cluster";

/**
 * IN-CONVERSATION SEARCH — the pure text side. The chat search must find a query EVEN inside content that
 * is collapsed by default (tool input/output, thinking), so a match is never hidden. This module extracts
 * ALL the searchable text of a turn — including that collapsed plumbing — so MessageList can decide which
 * turns match and force the matching collapsed sections open. Pure + unit-testable; the UI owns rendering.
 */

const blockText = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");

/**
 * The full searchable text of ONE turn — what a query is tested against. Pulls the visible prose AND the
 * normally-collapsed detail: a user/assistant message's text, thinking, a command + its output, a system
 * note, AND a tool-use's input summary + its tool-result's extracted text (ANSI stripped, so a colorized
 * Bash result still matches on its plain content). Returns "" for turns with no searchable text.
 */
export function turnSearchText(turn: TurnItem): string {
  switch (turn.kind) {
    case "user":
      return blockText(turn.blocks);
    case "assistant-text":
    case "thinking":
    case "system-note":
      return turn.text;
    case "command":
      return [turn.command, turn.output].filter(Boolean).join(" ");
    case "tool-use":
      return `${turn.name} ${summarizeToolInput(turn.input)}`;
    case "tool-result":
      return stripAnsi(parseToolResult(turn.content).text);
    case "asked-question":
      return [...turn.questions.map((q) => `${q.header ?? ""} ${q.question}`), turn.answer ?? ""].join(" ");
    case "attachment":
      return [turn.name, turn.caption ?? "", turn.path].join(" ");
    case "result":
      return turn.result ?? "";
    case "rewound":
      return "";
    case "subagent-ref":
      return "";
  }
}

/** Case-insensitive substring match of `query` in `text`. An empty/whitespace query matches nothing
 *  (search is inactive), so clearing the box restores the full list. */
export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return text.toLowerCase().includes(q);
}

/** True when a turn's searchable text (incl. collapsed plumbing) contains the query. */
export function turnMatches(turn: TurnItem, query: string): boolean {
  return matchesQuery(turnSearchText(turn), query);
}

/** Count the (non-overlapping) occurrences of `query` across all turns' searchable text — drives the
 *  "N matches" readout. Case-insensitive; empty query → 0. */
export function countMatches(turns: TurnItem[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let total = 0;
  for (const turn of turns) {
    const hay = turnSearchText(turn).toLowerCase();
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(q, from);
      if (idx < 0) break;
      total += 1;
      from = idx + q.length;
    }
  }
  return total;
}
