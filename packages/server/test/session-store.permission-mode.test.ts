import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openSessionStore } from "../src/index.js";
import type { SessionStore, StoredSession } from "../src/index.js";

let dir: string;
let store: SessionStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-pm-"));
  store = openSessionStore({ dbPath: join(dir, "s.db") });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const sample = (): StoredSession => ({
  id: "a", cwd: "/w", dangerouslySkip: false, status: "running", createdAt: 1, lastActivityAt: 1, permissionMode: "acceptEdits",
});

test("permissionMode round-trips through upsert/get", () => {
  store.upsert(sample());
  expect(store.get("a")?.permissionMode).toBe("acceptEdits");
});

test("permissionMode survives reopening the db (durability + migration-safe column)", () => {
  store.upsert(sample());
  store.close();
  const reopened = openSessionStore({ dbPath: join(dir, "s.db") });
  expect(reopened.get("a")?.permissionMode).toBe("acceptEdits");
  reopened.close();
});
