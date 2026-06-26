export interface TranscriptTurn {
  type: "user" | "assistant";
  message: unknown;
  uuid?: string;
  parentUuid?: string | null;
  /** True for an INJECTED user-role line — context for the model, not something the human typed, so the
   * client must skip rendering it as a "YOU" bubble in replayed history (exactly as the live frame path
   * does). Two sources: claude flags skill content / tool reminders with `isMeta:true`; the harness tags
   * messages IT injected (e.g. a background `task-notification`) with an `origin.kind` (a human message
   * has none) — both are folded into this single flag here. */
  isMeta?: boolean;
  /** The Agent/Task tool_use id this line belongs to — set for a SUBAGENT's own (sidechain) lines so the
   * reducer routes them into that subagent's thread on reopen instead of LEAKING them into the main chat.
   * Carried through from `parent_tool_use_id` (else `agentId`, else a `"sidechain"` bucket). */
  parentToolUseId?: string;
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

/** A user line that carries an `origin.kind` was INJECTED by the harness (e.g. a background
 *  `task-notification`), not typed by the human — a human message has no `origin`. Treated as meta so it
 *  never renders as a "YOU" bubble on reopen. */
function isInjectedOrigin(origin: unknown): boolean {
  return typeof (origin as { kind?: unknown } | null)?.kind === "string";
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
    // Carry the subagent parent linkage so reopened sidechain (subagent) lines route into their thread,
    // never the main chat. Prefer the line's own parent_tool_use_id; else (a sidechain line missing it)
    // fall back to its agentId, else a constant bucket — the invariant is "never leak into main".
    const sidechain = obj.isSidechain === true;
    const parentToolUseId =
      typeof obj.parent_tool_use_id === "string"
        ? obj.parent_tool_use_id
        : sidechain
          ? typeof obj.agentId === "string"
            ? obj.agentId
            : "sidechain"
          : undefined;
    turns.push({
      type: obj.type,
      message: obj.message,
      uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
      parentUuid: typeof obj.parentUuid === "string" ? obj.parentUuid : obj.parentUuid === null ? null : undefined,
      isMeta: obj.isMeta === true || isInjectedOrigin(obj.origin) ? true : undefined,
      parentToolUseId,
    });
  }
  return turns;
}
