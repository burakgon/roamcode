import { readFile } from "node:fs/promises";
import { statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
}
