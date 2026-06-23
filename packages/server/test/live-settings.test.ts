import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionManager, SessionHub } from "../src/index.js";

const MOCK = fileURLToPath(new URL("./helpers/mock-claude-interactive.mjs", import.meta.url));

let hub: SessionHub | undefined;
afterEach(() => {
  hub?.stopAll();
  hub = undefined;
});

test("applySettings sends controls and mirrors model/effort into the session meta", async () => {
  const manager = new SessionManager(
    { claudeBin: process.execPath },
    { spawnPrefixArgs: [MOCK], baseEnv: { ...process.env, MOCK_MODE: "simple" }, startTimeoutMs: 5000 },
  );
  hub = new SessionHub(manager);
  const meta = await hub.createSession({ cwd: process.cwd(), model: "claude-mock" });

  const updated = hub.applySettings(meta.id, { model: "claude-opus-4-8", maxThinkingTokens: 8000, effort: "high", permissionMode: "acceptEdits" });
  expect(updated.model).toBe("claude-opus-4-8");
  expect(updated.effort).toBe("high");
  // getSession reflects the mutation.
  expect(hub.getSession(meta.id)?.model).toBe("claude-opus-4-8");
});
