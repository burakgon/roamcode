import { readFile } from "node:fs/promises";
import { statSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { encodeProjectDir, parseTranscript } from "@remote-coder/protocol";
import type { TranscriptTurn } from "@remote-coder/protocol";

export interface HistoryServiceOptions {
  /** Root that contains `.claude/projects/...`. Default the OS home dir. */
  claudeHome?: string;
}

/**
 * Reads a session's full conversation from Claude's own transcript file
 * (`<claudeHome>/.claude/projects/<encodeProjectDir(cwd)>/<id>.jsonl`). The cwd is the REAL
 * stored cwd (the encoding is lossy and is never reversed). Missing file -> [].
 */
export class HistoryService {
  readonly claudeHome: string;

  constructor(opts: HistoryServiceOptions = {}) {
    this.claudeHome = opts.claudeHome ?? homedir();
  }

  transcriptPath(cwd: string, sessionId: string): string {
    return join(this.claudeHome, ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
  }

  /**
   * Resolve a session's transcript file, TOLERANT of `encodeProjectDir` lossiness. `encodeProjectDir`
   * doesn't replicate Claude's truncation+hash branch for very long cwds, so the encoded path can miss —
   * and a miss used to (a) make a reopen read empty history and (b) make hasResumableTranscript delete a
   * genuinely-resumable session at boot. So: try the encoded path first (fast, exact for normal cwds),
   * and on a miss SCAN every `<projects>/<dir>/<id>.jsonl` for the session id. Sync (statSync/readdirSync)
   * so the boot/prune paths can call it. Returns undefined only when no NON-EMPTY transcript exists.
   */
  resolveTranscriptPath(cwd: string, sessionId: string): string | undefined {
    const direct = this.transcriptPath(cwd, sessionId);
    try {
      const st = statSync(direct);
      if (st.isFile() && st.size > 0) return direct;
    } catch {
      // encoded-path miss — fall through to the scan below
    }
    const projectsDir = join(this.claudeHome, ".claude", "projects");
    const fname = `${sessionId}.jsonl`;
    let dirs: string[];
    try {
      dirs = readdirSync(projectsDir);
    } catch {
      return undefined; // no projects dir at all
    }
    for (const d of dirs) {
      const cand = join(projectsDir, d, fname);
      try {
        const st = statSync(cand);
        if (st.isFile() && st.size > 0) return cand;
      } catch {
        // keep scanning
      }
    }
    return undefined;
  }

  async read(cwd: string, sessionId: string): Promise<TranscriptTurn[]> {
    const path = this.resolveTranscriptPath(cwd, sessionId);
    if (!path) return []; // no transcript yet (encoded path AND scan both missed)
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return []; // unreadable: treat as no history
    }
    return parseTranscript(text);
  }

  /**
   * Read a session's SUBAGENT transcripts so a reopen restores each subagent's inner turns (this CLI
   * stores them OUT of the main transcript). Layout (claude 2.1.187):
   *   <projectDir>/<sessionId>/subagents/agent-<id>.jsonl  + agent-<id>.meta.json
   * The .meta.json carries `toolUseId` (the spawning Agent tool_use id = the reducer's subagent-thread
   * key) and `spawnDepth`. The on-disk lines carry `agentId` (the FILE id, NOT the tool_use id), so we
   * FORCE each turn's `parentToolUseId` to the meta's `toolUseId` and sort depth-ascending so a nested
   * (depth-2) subagent folds AFTER its parent (whose turns create the nested thread). Returns [] when the
   * session has no subagents dir. Sync (mirrors resolveTranscriptPath); tolerant of missing/bad files.
   */
  readSubagents(cwd: string, sessionId: string): TranscriptTurn[] {
    const mainPath = this.resolveTranscriptPath(cwd, sessionId);
    if (!mainPath) return [];
    const subDir = join(dirname(mainPath), sessionId, "subagents");
    let files: string[];
    try {
      files = readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return []; // no subagents dir → nothing to restore
    }
    const agents: { depth: number; toolUseId: string; text: string }[] = [];
    for (const file of files) {
      let toolUseId: string | undefined;
      let depth = 1;
      try {
        const meta = JSON.parse(readFileSync(join(subDir, file.replace(/\.jsonl$/, ".meta.json")), "utf8")) as {
          toolUseId?: unknown;
          spawnDepth?: unknown;
        };
        if (typeof meta.toolUseId === "string") toolUseId = meta.toolUseId;
        if (typeof meta.spawnDepth === "number") depth = meta.spawnDepth;
      } catch {
        // no/unreadable meta → can't link this subagent to its thread; skip it
      }
      if (!toolUseId) continue;
      try {
        agents.push({ depth, toolUseId, text: readFileSync(join(subDir, file), "utf8") });
      } catch {
        // unreadable transcript — skip
      }
    }
    agents.sort((a, b) => a.depth - b.depth);
    const turns: TranscriptTurn[] = [];
    for (const a of agents) {
      for (const t of parseTranscript(a.text)) turns.push({ ...t, parentToolUseId: a.toolUseId });
    }
    return turns;
  }
}
