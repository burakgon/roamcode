import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, openPushStore } from "../src/index.js";
import type {
  CreateServerResult,
  ServerRuntimeConfig,
  PushStore,
  PushDispatcher,
  PushEvent,
  PushDispatchOptions,
} from "../src/index.js";

/** A push dispatcher that records the events it was asked to send (no real crypto/HTTP). `report` is what
 *  the push service accepted; service-worker display confirmation happens in the web client. */
function fakeDispatcher(report = { attempted: 1, delivered: 1, failures: [] as never[] }): {
  dispatcher: PushDispatcher;
  events: PushEvent[];
  options: Array<PushDispatchOptions | undefined>;
} {
  const events: PushEvent[] = [];
  const options: Array<PushDispatchOptions | undefined> = [];
  return {
    dispatcher: {
      dispatch: async (event, dispatchOptions) => {
        events.push(event);
        options.push(dispatchOptions);
        return report;
      },
    },
    events,
    options,
  };
}

let dir: string;
let store: PushStore;
let result: CreateServerResult | undefined;
const TOKEN = "tok";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rc-pushroute-"));
  store = openPushStore({ dbPath: join(dir, "push.db") });
});
afterEach(async () => {
  if (result) await result.app.close();
  result = undefined;
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function configFor(): ServerRuntimeConfig {
  return {
    port: 0,
    bindAddress: "127.0.0.1",
    accessToken: TOKEN,
    fsRoot: dir,
    maxUploadBytes: 26214400,
    dataDir: dir,
    claude: { claudeBin: process.execPath },
  };
}
const auth = { authorization: `Bearer ${TOKEN}` };

test("GET /push/vapid returns the public key (token-gated)", async () => {
  result = createServer(configFor(), {
    pushStore: store,
    vapidPublicKey: "PUBKEY",
  });
  const noTok = await result.app.inject({ method: "GET", url: "/push/vapid" });
  expect(noTok.statusCode).toBe(401);
  const res = await result.app.inject({ method: "GET", url: "/push/vapid", headers: auth });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ publicKey: "PUBKEY" });
});

test("GET /push/vapid never leaks a private key", async () => {
  result = createServer(configFor(), {
    pushStore: store,
    vapidPublicKey: "PUBKEY",
  });
  const res = await result.app.inject({ method: "GET", url: "/push/vapid", headers: auth });
  // ONLY publicKey — no privateKey field, and the raw body must not carry the secret name.
  expect(Object.keys(res.json() as object)).toEqual(["publicKey"]);
  expect(res.body).not.toContain("privateKey");
  expect(res.body).not.toContain("private");
});

test("POST /push/subscribe persists the subscription; /push/unsubscribe removes it", async () => {
  result = createServer(configFor(), {
    pushStore: store,
    vapidPublicKey: "PUBKEY",
  });
  const body = { endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" } };
  const sub = await result.app.inject({ method: "POST", url: "/push/subscribe", headers: auth, payload: body });
  expect(sub.statusCode).toBe(201);
  expect(store.list().map((s) => s.endpoint)).toEqual(["https://push/1"]);
  const unsub = await result.app.inject({
    method: "POST",
    url: "/push/unsubscribe",
    headers: auth,
    payload: { endpoint: "https://push/1" },
  });
  expect(unsub.statusCode).toBe(200);
  expect(store.list()).toEqual([]);
});

test("POST /push/subscribe stores the optional session scope", async () => {
  result = createServer(configFor(), {
    pushStore: store,
    vapidPublicKey: "PUBKEY",
  });
  const body = { endpoint: "https://push/scoped", keys: { p256dh: "p", auth: "a" }, sessionId: "sess-1" };
  const sub = await result.app.inject({ method: "POST", url: "/push/subscribe", headers: auth, payload: body });
  expect(sub.statusCode).toBe(201);
  expect(store.list()[0]?.sessionId).toBe("sess-1");
});

test("POST /push/subscribe rejects a malformed body with 400", async () => {
  result = createServer(configFor(), {
    pushStore: store,
    vapidPublicKey: "PUBKEY",
  });
  // Missing keys -> 4xx (validated, not a crash).
  const res = await result.app.inject({
    method: "POST",
    url: "/push/subscribe",
    headers: auth,
    payload: { endpoint: "https://push/1" },
  });
  expect(res.statusCode).toBe(400);
  expect(store.list()).toEqual([]);
});

test("all /push/* routes 401 without a token", async () => {
  result = createServer(configFor(), {
    pushStore: store,
    vapidPublicKey: "PUBKEY",
  });
  for (const r of [
    { method: "GET" as const, url: "/push/vapid" },
    { method: "POST" as const, url: "/push/subscribe", payload: { endpoint: "x", keys: { p256dh: "p", auth: "a" } } },
    { method: "POST" as const, url: "/push/unsubscribe", payload: { endpoint: "x" } },
  ]) {
    const res = await result.app.inject(r);
    expect(res.statusCode, `${r.method} ${r.url} should 401 without a token`).toBe(401);
  }
});

test("push routes 404 when push is not configured (no store/key)", async () => {
  result = createServer(configFor(), {});
  const res = await result.app.inject({ method: "GET", url: "/push/vapid", headers: auth });
  expect(res.statusCode).toBe(404);
});

test("POST /push/test targets the current endpoint and returns push-service acceptance", async () => {
  const { dispatcher, events, options } = fakeDispatcher();
  result = createServer(configFor(), { pushStore: store, vapidPublicKey: "PUBKEY", pushDispatcher: dispatcher });
  store.upsert({ endpoint: "https://push/1", p256dh: "p", auth: "a", createdAt: 0 });
  const res = await result.app.inject({
    method: "POST",
    url: "/push/test",
    headers: auth,
    payload: { endpoint: "https://push/1", testId: "test-123" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, attempted: 1, delivered: 1 });
  expect(events).toEqual([{ kind: "test", testId: "test-123" }]);
  expect(options).toEqual([{ endpoint: "https://push/1" }]);
});

test("POST /push/test returns ok:false when this endpoint is not registered", async () => {
  const { dispatcher, events } = fakeDispatcher({ attempted: 0, delivered: 0, failures: [] });
  result = createServer(configFor(), { pushStore: store, vapidPublicKey: "PUBKEY", pushDispatcher: dispatcher });
  const res = await result.app.inject({
    method: "POST",
    url: "/push/test",
    headers: auth,
    payload: { endpoint: "https://push/missing" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: false,
    attempted: 0,
    delivered: 0,
    reason: "this device is not registered for push",
  });
  expect(events).toEqual([{ kind: "test" }]);
});

test("POST /push/test refuses an unscoped legacy request instead of fanning out", async () => {
  const { dispatcher, events } = fakeDispatcher();
  result = createServer(configFor(), { pushStore: store, vapidPublicKey: "PUBKEY", pushDispatcher: dispatcher });
  store.upsert({ endpoint: "https://push/other-device", p256dh: "p", auth: "a", createdAt: 0 });

  const res = await result.app.inject({ method: "POST", url: "/push/test", headers: auth });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: false,
    reason: "current device subscription is required; reopen the app and retry",
  });
  expect(events).toEqual([]);
});

test("POST /push/test returns ok:false when push is not configured", async () => {
  result = createServer(configFor(), {}); // no dispatcher / store
  const res = await result.app.inject({
    method: "POST",
    url: "/push/test",
    headers: auth,
    payload: { endpoint: "https://push/1" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: false, reason: "push not configured" });
});

test("POST /push/test is token-gated (401 without auth)", async () => {
  const { dispatcher } = fakeDispatcher();
  result = createServer(configFor(), { pushStore: store, vapidPublicKey: "PUBKEY", pushDispatcher: dispatcher });
  const res = await result.app.inject({ method: "POST", url: "/push/test" });
  expect(res.statusCode).toBe(401);
});

test("POST /push/test reports a push service REJECTION instead of claiming success", async () => {
  // The route used to answer ok:true for any completed fan-out, so a channel that delivered to nobody — the
  // exact "I never get notifications" case — was confirmed as working.
  const { dispatcher } = fakeDispatcher({
    attempted: 1,
    delivered: 0,
    failures: [{ endpoint: "https://push/1", statusCode: 403 }] as never[],
  });
  result = createServer(configFor(), { pushStore: store, vapidPublicKey: "PUBKEY", pushDispatcher: dispatcher });
  store.upsert({ endpoint: "https://push/1", p256dh: "p", auth: "a", createdAt: 0 });

  const res = await result.app.inject({
    method: "POST",
    url: "/push/test",
    headers: auth,
    payload: { endpoint: "https://push/1" },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: false,
    attempted: 1,
    delivered: 0,
    reason: "the push service rejected it (HTTP 403)",
  });
});
