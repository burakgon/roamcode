import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openPushStore } from "../src/index.js";
import type { PushStore, PushSubscriptionRecord } from "../src/index.js";

let dir: string;
let store: PushStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-push-"));
  store = openPushStore({ dbPath: join(dir, "push.db") });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function sub(endpoint: string, sessionId?: string): PushSubscriptionRecord {
  const r: PushSubscriptionRecord = { endpoint, p256dh: "p_" + endpoint, auth: "a_" + endpoint, createdAt: 1000 };
  if (sessionId) r.sessionId = sessionId;
  return r;
}

test("upsert + list round-trips a subscription", () => {
  store.upsert(sub("https://push/1"));
  expect(store.list()).toEqual([sub("https://push/1")]);
});

test("upsert is idempotent on the endpoint primary key", () => {
  store.upsert(sub("https://push/1"));
  store.upsert({ ...sub("https://push/1"), auth: "new" });
  const list = store.list();
  expect(list).toHaveLength(1);
  expect(list[0]?.auth).toBe("new");
});

test("remove deletes a dead endpoint (pruning)", () => {
  store.upsert(sub("https://push/1"));
  store.upsert(sub("https://push/2"));
  store.remove("https://push/1");
  expect(store.list().map((s) => s.endpoint)).toEqual(["https://push/2"]);
});

test("list({ sessionId }) returns global (NULL-scope) UNION the session-scoped subscriptions", () => {
  store.upsert(sub("https://push/global")); // global (no sessionId)
  store.upsert(sub("https://push/sessA", "A")); // scoped to A
  store.upsert(sub("https://push/sessB", "B")); // scoped to B
  const forA = store
    .list({ sessionId: "A" })
    .map((s) => s.endpoint)
    .sort();
  expect(forA).toEqual(["https://push/global", "https://push/sessA"]);
});

test("data survives reopening the same db file (durability)", () => {
  store.upsert(sub("https://push/1"));
  store.close();
  const reopened = openPushStore({ dbPath: join(dir, "push.db") });
  expect(reopened.list()).toEqual([sub("https://push/1")]);
  reopened.close();
});

test("parameterized SQL holds an injection-shaped endpoint/keys safely", () => {
  // Opaque, client-supplied strings full of SQL metacharacters must round-trip
  // verbatim — proving binds, not concatenation.
  const evil: PushSubscriptionRecord = {
    endpoint: "https://push/1'); DROP TABLE push_subscriptions;--",
    p256dh: "key with \" double and ' single quotes",
    auth: "tab\tnewline\nand;semicolons --",
    createdAt: 1000,
  };
  store.upsert(evil);
  store.upsert(sub("https://push/survivor"));
  // Table still exists and BOTH rows are present (the DROP was bound as data).
  expect(store.list()).toEqual([evil, sub("https://push/survivor")]);
  // The exact weird endpoint is removable by its literal value.
  store.remove(evil.endpoint);
  expect(store.list().map((s) => s.endpoint)).toEqual(["https://push/survivor"]);
});

test("the in-memory fallback matches the SQLite semantics", () => {
  // Force the in-memory path with a :memory: db (and also exercise it directly
  // via the same public surface so upsert/list/remove parity is asserted).
  const mem = openPushStore({ dbPath: ":memory:" });
  mem.upsert(sub("https://push/g"));
  mem.upsert(sub("https://push/a", "A"));
  mem.upsert({ ...sub("https://push/a", "A"), auth: "updated" }); // upsert, not dup
  expect(mem.list()).toHaveLength(2);
  expect(
    mem
      .list({ sessionId: "A" })
      .map((s) => s.endpoint)
      .sort(),
  ).toEqual(["https://push/a", "https://push/g"]);
  expect(mem.list({ sessionId: "A" }).find((s) => s.endpoint === "https://push/a")?.auth).toBe("updated");
  mem.remove("https://push/g");
  expect(mem.list().map((s) => s.endpoint)).toEqual(["https://push/a"]);
  mem.close();
});
