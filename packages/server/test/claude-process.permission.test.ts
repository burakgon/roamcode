import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { expect, test } from "vitest";
import { ClaudeProcess, type PermissionEvent } from "../src/index.js";
import type { ResultEvent } from "@remote-coder/protocol";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

function makePermissionProc() {
  const proc = new ClaudeProcess({
    claudeBin: process.execPath,
    cwd: process.cwd(),
    sessionId: "sid-perm",
    env: { ...process.env, MOCK_MODE: "permission" },
    startTimeoutMs: 5000,
  });
  proc.setSpawnPrefixArgsForTest([MOCK]);
  return proc;
}

test("permission round-trip: receive 'permission', allow, tool proceeds to result with no denials", async () => {
  const proc = makePermissionProc();
  await proc.start();

  const permPromise: Promise<PermissionEvent[]> = once(proc, "permission") as Promise<PermissionEvent[]>;
  const resultPromise: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;

  proc.sendUserMessage("write a file");

  const [perm] = await permPromise;
  expect(perm.kind).toBe("hook_callback");
  expect(perm.toolName).toBe("Write");
  expect(perm.toolUseId).toBe("toolu_mock_0001");
  expect(typeof perm.requestId).toBe("string");

  proc.answerPermission(perm.requestId, "allow", "approved in test");

  const [result] = await resultPromise;
  expect(result.permissionDenials).toEqual([]);
  proc.stop();
});

test("permission round-trip: deny blocks the tool (result has a denial)", async () => {
  const proc = makePermissionProc();
  await proc.start();

  const permPromise: Promise<PermissionEvent[]> = once(proc, "permission") as Promise<PermissionEvent[]>;
  const resultPromise: Promise<ResultEvent[]> = once(proc, "result") as Promise<ResultEvent[]>;

  proc.sendUserMessage("write a file");
  const [perm] = await permPromise;
  proc.answerPermission(perm.requestId, "deny", "blocked in test");

  const [result] = await resultPromise;
  expect(Array.isArray(result.permissionDenials)).toBe(true);
  expect((result.permissionDenials ?? []).length).toBe(1);
  proc.stop();
});
