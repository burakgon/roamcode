import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { ClaudeProcess } from "../src/index.js";
import type { ResultEvent } from "@remote-coder/protocol";

// LIVE end-to-end proof of the REWIND / CHECKPOINT file-restore cycle against the REAL `claude` binary,
// driven entirely through the production ClaudeProcess code path (spawn args, the enable env var, the
// replayed-user-message uuid capture, and the rewind_files control_request). It needs a real auth'd
// `claude` login session, so it is GATED behind RC_LIVE_E2E=1 and skipped in normal CI. Run it on a
// host that has `claude` logged in:  RC_LIVE_E2E=1 CLAUDE_BIN=$HOME/.local/bin/claude pnpm vitest run
// packages/server/test/rewind.live-e2e.test.ts
const LIVE = process.env.RC_LIVE_E2E === "1";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(process.env.HOME ?? "", ".local/bin/claude");

describe.runIf(LIVE)("REWIND live e2e (real claude)", () => {
  test(
    "Write creates a file, then rewindFiles(checkpoint) deletes it and returns ok:true",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rc-rewind-e2e-"));
      const target = join(cwd, "rc-spike.txt");
      rmSync(target, { force: true });

      const proc = new ClaudeProcess({
        claudeBin: CLAUDE_BIN,
        cwd,
        sessionId: randomUUID(),
        dangerouslySkip: true, // auto-allows the Write tool's PreToolUse hook through the real code path
        startTimeoutMs: 30000,
      });

      // Capture the checkpoint uuid (the replayed user message) and the turn's result.
      let checkpointId: string | undefined;
      const firstResult = new Promise<ResultEvent>((resolve) => {
        proc.on("event", (ev) => {
          if (ev.type === "user") {
            const uuid = (ev.raw as { uuid?: string } | undefined)?.uuid;
            if (uuid && !checkpointId) checkpointId = uuid;
          }
        });
        proc.on("result", (r) => resolve(r));
      });

      await proc.start();
      proc.sendUserMessage(`Use the Write tool to create ${target} with exactly the text HELLO. Then stop.`);
      await firstResult;

      // The file was really created on disk, and we captured the turn's checkpoint uuid.
      expect(existsSync(target)).toBe(true);
      expect(checkpointId).toBeTruthy();

      // Rewind FILES to the checkpoint via the live rewind_files control_request.
      const result = await proc.rewindFiles(checkpointId!, { timeoutMs: 20000 });

      expect(result.ok).toBe(true);
      expect(result.canRewind).toBe(true);
      // The created file was restored away (deleted) by the rewind.
      expect(existsSync(target)).toBe(false);

      proc.stop();
      rmSync(cwd, { recursive: true, force: true });
    },
    120000,
  );
});
