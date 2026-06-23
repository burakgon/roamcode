export interface TranscriptTurn {
  type: "user" | "assistant";
  message: unknown;
  uuid?: string;
  parentUuid?: string | null;
}

/**
 * Compute the `~/.claude/projects/<dir>` directory name for a cwd. LOSSY: every
 * non-alphanumeric char (including `/`, `.`, `_`, space) maps to `-`. The daemon stores the
 * REAL cwd per session and computes this from it; it must never be reversed back to a path.
 *
 * KNOWN LIMITATION (Plan 6): this mirrors Claude's simple substitution but does NOT replicate
 * Claude's truncation + base36-hash branch for very long paths (the real binary truncates the
 * encoded name past a max length and appends `-<base36-hash-of-full-cwd>`). For typical cwds the
 * result matches Claude exactly; for an unusually long cwd it can diverge, so on-disk transcript
 * history reads empty and the server falls back to the in-memory replay buffer for the current
 * session. Porting the full truncation+hash branch is future work — the exact cap/hash is not
 * pinned here on purpose (it is unverified). See docs/protocol-notes.md.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function soleText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0] as { type?: string; text?: string };
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/**
 * Parse a `<session-id>.jsonl` transcript into renderable user/assistant turns, in file order.
 * Keeps only `type ∈ {user, assistant}`; drops bookkeeping lines, malformed lines, and the
 * synthetic --resume warm-up pair ("Continue from where you left off." / "No response requested.").
 */
export function parseTranscript(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue; // malformed line: skip defensively
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue; // drop bookkeeping
    const text = soleText(obj.message);
    if (text === "Continue from where you left off." || text === "No response requested.") continue;
    turns.push({
      type: obj.type,
      message: obj.message,
      uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
      parentUuid: typeof obj.parentUuid === "string" ? obj.parentUuid : obj.parentUuid === null ? null : undefined,
    });
  }
  return turns;
}
