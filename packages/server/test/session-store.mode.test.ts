import { expect, test } from "vitest";
import { openSessionStore } from "../src/session-store.js";

function store() {
  return openSessionStore({ dbPath: ":memory:" });
}

test("mode round-trips and defaults to 'terminal' when absent (legacy rows)", () => {
  const s = store();
  s.upsert({
    provider: "claude",
    id: "t1",
    cwd: "/tmp",
    mode: "terminal",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
  });
  s.upsert({
    provider: "claude",
    id: "t2",
    cwd: "/tmp",
    dangerouslySkip: false,
    status: "running",
    createdAt: 1,
    lastActivityAt: 1,
  } as never); // omit mode → defaults to terminal
  expect(s.get("t1")?.mode).toBe("terminal");
  expect(s.get("t2")?.mode).toBe("terminal");
  expect(s.list().find((r) => r.id === "t1")?.mode).toBe("terminal");
  s.close();
});
