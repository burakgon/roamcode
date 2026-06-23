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
