import { readFile } from "node:fs/promises";
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

  async read(cwd: string, sessionId: string): Promise<TranscriptTurn[]> {
    let text: string;
    try {
      text = await readFile(this.transcriptPath(cwd, sessionId), "utf8");
    } catch {
      return []; // ENOENT (or unreadable): no history yet
    }
    return parseTranscript(text);
  }
}
