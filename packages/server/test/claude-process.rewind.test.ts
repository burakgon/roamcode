import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ClaudeProcess } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makeProc(mode = "simple") {
  return new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-rewind",
    env: { ...process.env, MOCK_MODE: mode },
    startTimeoutMs: 5000,
  });
}

test("rewindFiles() sends a rewind_files control_request and resolves with the CLI's structured result", async () => {
  const proc = makeProc();
  proc.setSpawnPrefixArgsForTest([MOCK]);
  await proc.start();

  const result = await proc.rewindFiles("48cc3094-0c06-478c-b08c-367995fbfbad");
  expect(result.ok).toBe(true);
  expect(result.canRewind).toBe(true);
  expect(result.filesChanged).toEqual(["/mock/cwd/spike.txt"]);
  expect(result.deletions).toBe(1);

  proc.stop();
});

test("rewindFiles() surfaces a CLI error (checkpointing disabled) as ok:false with the message", async () => {
  const proc = makeProc("rewind-disabled");
  proc.setSpawnPrefixArgsForTest([MOCK]);
  await proc.start();

  const result = await proc.rewindFiles("uuid-y");
  expect(result.ok).toBe(false);
  expect(result.error).toBe("File rewinding is not enabled.");

  proc.stop();
});

test("the spawn enables file checkpointing via the CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING env var", async () => {
  // The mock echoes its own env back as a diagnostic so we can assert the enable var was set on the child.
  const proc = makeProc("echo-env");
  proc.setSpawnPrefixArgsForTest([MOCK]);
  const diagnostics: string[] = [];
  proc.on("diagnostic", (d) => diagnostics.push(d.message));
  await proc.start();
  // Give the env diagnostic a beat to flush.
  await new Promise((r) => setTimeout(r, 50));
  expect(diagnostics.some((m) => m.includes("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true"))).toBe(true);
  proc.stop();
});
