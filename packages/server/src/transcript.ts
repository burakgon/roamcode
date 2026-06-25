import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseLine } from "@remote-coder/protocol";
import type { ServerFrame } from "./replay-buffer.js";

/**
 * Resume backend (`claude --resume` equivalent). This module is PURE + side-effect-free except for the
 * filesystem helpers (`listResumable`/`findTranscriptFile`), which only READ. It mirrors how Claude
 * Code stores past sessions on disk:
 *
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * where each line is a JSON object. We keep only the `user`/`assistant` lines (the renderable turns),
 * skip `isSidechain:true` lines (sub-agent chatter) and every other bookkeeping line, and re-wrap the
 * kept lines into the SAME `event` ServerFrames the live `claude-process.ts` pipeline emits — so the
 * existing frame-reducer renders a resumed conversation identically to a live one.
 */

/** A renderable user/assistant turn parsed from a transcript line, in file order. */
export interface TranscriptMessage {
  type: "user" | "assistant";
  /** The Anthropic `message` object (`{ role, content }`), passed through verbatim. */
  message: unknown;
  uuid?: string;
  /** Epoch ms parsed from the line's ISO `timestamp`, when present. */
  timestamp?: number;
  /** The full raw parsed line (so transcriptToFrames can re-wrap it exactly like the live pipeline). */
  raw: Record<string, unknown>;
}

export interface ParsedTranscript {
  messages: TranscriptMessage[];
  cwd?: string;
  gitBranch?: string;
  /** First user message's text, trimmed + truncated (~100 chars). Empty string when none. */
  summary: string;
  /** Epoch ms of the latest message timestamp seen, when any line carried one. */
  lastActivityTs?: number;
  /** Count of kept user+assistant messages. */
  messageCount: number;
}

/** One row of `GET /resumable`: enough to render a "resume this conversation" list entry. */
export interface ResumableSession {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  summary: string;
  /** Epoch ms — the transcript file's mtime (recency for the list ordering). */
  lastActivity: number;
  messageCount: number;
}

export interface ListResumableOptions {
  /** Keep only transcripts whose `cwd` equals this. */
  cwd?: string;
  /** Cap the returned list (default 100). */
  limit?: number;
}

const SUMMARY_MAX = 100;
/** The synthetic `--resume` warm-up pair Claude injects — never user-authored, so never a summary. */
const WARMUP_TEXTS = new Set(["Continue from where you left off.", "No response requested."]);

/** Default `~/.claude/projects` dir. Resolved centrally so HOME/homedir() is read in exactly one place. */
export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** The single text-block string of a `message.content` array, else undefined. Tolerant of any shape. */
function soleText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  // First text block wins (a user turn may carry attachments alongside the text).
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") return b.text;
  }
  return undefined;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SUMMARY_MAX ? trimmed.slice(0, SUMMARY_MAX) : trimmed;
}

/** Parse an ISO/epoch timestamp into epoch ms, else undefined. */
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/**
 * Parse a `<session-id>.jsonl` transcript. Version-tolerant + robust:
 *  - splits on newlines, JSON.parses each line, SKIPS a malformed line (never throws),
 *  - keeps every `type ∈ {user, assistant}` (INCLUDING `isSidechain:true` subagent turns), preserving
 *    file order, so a resumed session can show its historical subagents,
 *  - CARRIES the subagent parent linkage: a kept sidechain line is tagged with a `parent_tool_use_id`
 *    (from its own `parent_tool_use_id`, else its `agentId`) so the frame-reducer routes it into a
 *    subagent thread instead of polluting the main chat. (If the line carries NO linkage at all it is
 *    still kept under a `"sidechain"` bucket — never the main thread.) NOTE: this version of claude
 *    stores subagents in SEPARATE files (`<dir>/subagents/agent-*.jsonl`) rather than inline, so a
 *    main transcript may contain no sidechain lines; the live WS path is the proven one.
 *  - drops the synthetic warm-up pair so it never pollutes the summary or the message count,
 *  - pulls `cwd`/`gitBranch` from ANY line that carries them,
 *  - `summary` = the first real (non-sidechain) user message's text (trimmed, ~100 chars),
 *  - unknown content-block types in `message.content` pass through untouched (downstream renders them).
 */
export function parseTranscript(jsonl: string): ParsedTranscript {
  const messages: TranscriptMessage[] = [];
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let summary = "";
  let lastActivityTs: number | undefined;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // malformed line: skip defensively, never throw
    }
    // cwd/gitBranch may live on bookkeeping lines too — harvest from EVERY line.
    if (cwd === undefined && typeof obj.cwd === "string") cwd = obj.cwd;
    if (gitBranch === undefined && typeof obj.gitBranch === "string") gitBranch = obj.gitBranch;

    if (obj.type !== "user" && obj.type !== "assistant") continue; // drop bookkeeping/noise lines

    const text = soleText(obj.message);
    if (text !== undefined && WARMUP_TEXTS.has(text)) continue; // drop the --resume warm-up pair

    const sidechain = obj.isSidechain === true;
    // KEEP sidechain lines, but ensure they carry a parent linkage so the reducer routes them into a
    // subagent thread (and OUT of the main chat). Prefer an existing parent_tool_use_id, else the
    // on-disk `agentId`, else a constant bucket — the invariant is "never leak into main".
    if (sidechain && typeof obj.parent_tool_use_id !== "string") {
      obj.parent_tool_use_id = typeof obj.agentId === "string" ? obj.agentId : "sidechain";
    }

    const ts = parseTimestamp(obj.timestamp);
    if (ts !== undefined && (lastActivityTs === undefined || ts > lastActivityTs)) lastActivityTs = ts;

    // The summary is the first MAIN (non-sidechain) user message — a subagent's prompt never wins it.
    if (summary === "" && !sidechain && obj.type === "user" && text !== undefined && text.trim() !== "") {
      summary = truncate(text);
    }

    messages.push({
      type: obj.type,
      message: obj.message,
      uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
      timestamp: ts,
      raw: obj,
    });
  }

  return { messages, cwd, gitBranch, summary, lastActivityTs, messageCount: messages.length };
}

/**
 * Convert a parsed transcript into the `event` ServerFrames the live pipeline produces. We re-serialize
 * each kept line and run it through the SAME `parseLine` claude-process.ts uses, so each frame's payload
 * is the exact `InboundEvent` shape (`{ type, message, sessionId, raw }`) a live `user`/`assistant`
 * stream-json event yields — and the existing frame-reducer renders them identically (assistant text /
 * thinking / tool_use, and user tool_result turns). seq is 1-based and contiguous, matching a fresh
 * ReplayBuffer so these frames can be pre-loaded as a session's replayed history.
 */
export function transcriptToFrames(parsed: ParsedTranscript): ServerFrame[] {
  const frames: ServerFrame[] = [];
  for (const msg of parsed.messages) {
    const ev = parseLine(JSON.stringify(msg.raw));
    if (!ev) continue;
    frames.push({ seq: frames.length + 1, kind: "event", payload: ev });
  }
  return frames;
}

/**
 * Scan `<projectsDir>/<*>/<*.jsonl>` and build one ResumableSession per transcript, recent-first.
 * `lastActivity` is the file mtime (cheap + monotonic with use). Empty/zero-message transcripts are
 * skipped. Filters by `opts.cwd` when given; caps at `opts.limit ?? 100`. Tolerant: an unreadable file
 * or dir is skipped, never fatal.
 */
export async function listResumable(
  projectsDir: string = defaultProjectsDir(),
  opts: ListResumableOptions = {},
): Promise<ResumableSession[]> {
  const limit = opts.limit ?? 100;
  let projectDirs: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => join(projectsDir, e.name));
  } catch {
    return []; // projects dir missing/unreadable → nothing resumable
  }

  const rows: ResumableSession[] = [];
  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(dir, file);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch {
        continue;
      }
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }
      const parsed = parseTranscript(text);
      if (parsed.messageCount === 0) continue; // skip empty transcripts
      if (opts.cwd !== undefined && parsed.cwd !== opts.cwd) continue;
      rows.push({
        sessionId: basename(file, ".jsonl"),
        cwd: parsed.cwd,
        gitBranch: parsed.gitBranch,
        summary: parsed.summary,
        lastActivity: mtimeMs,
        messageCount: parsed.messageCount,
      });
    }
  }

  rows.sort((a, b) => b.lastActivity - a.lastActivity);
  return rows.slice(0, limit);
}

/** Locate `<sessionId>.jsonl` across the project dirs, returning its absolute path or undefined. */
export async function findTranscriptFile(
  projectsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  const target = `${sessionId}.jsonl`;
  let projectDirs: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => join(projectsDir, e.name));
  } catch {
    return undefined;
  }
  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    if (files.includes(target)) return join(dir, target);
  }
  return undefined;
}
