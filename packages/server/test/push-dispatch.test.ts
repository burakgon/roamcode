import { expect, test, vi } from "vitest";
import { buildPushPayload, createPushDispatcher } from "../src/push-dispatch.js";
import type { PushEvent } from "../src/push-dispatch.js";
import type { PushStore, PushSubscriptionRecord } from "../src/push-store.js";
import type { PushSendFn } from "../src/web-push-send.js";

/** A tiny in-memory PushStore (a subset — only what the dispatcher uses). */
function fakeStore(subs: PushSubscriptionRecord[]): PushStore & { removed: string[] } {
  const removed: string[] = [];
  const list = [...subs];
  return {
    removed,
    upsert: () => {},
    list: (opts) => {
      if (!opts?.sessionId) return [...list];
      // Mirror the real store: global (no sessionId) UNION session-scoped matches.
      return list.filter((s) => s.sessionId === undefined || s.sessionId === opts.sessionId);
    },
    remove: (endpoint) => {
      removed.push(endpoint);
      const i = list.findIndex((s) => s.endpoint === endpoint);
      if (i >= 0) list.splice(i, 1);
    },
    close: () => {},
  };
}

const sub = (endpoint: string, sessionId?: string): PushSubscriptionRecord => ({
  endpoint,
  p256dh: "p",
  auth: "a",
  createdAt: 0,
  ...(sessionId ? { sessionId } : {}),
});

test("buildPushPayload deep-links + tags on the session and only awaiting/ask require interaction", () => {
  const kinds: { event: PushEvent; requireInteraction: boolean }[] = [
    { event: { kind: "awaiting", sessionId: "s1" }, requireInteraction: true },
    { event: { kind: "ask", sessionId: "s1", detail: "Pick one" }, requireInteraction: true },
    { event: { kind: "file", sessionId: "s1", detail: "shot.png" }, requireInteraction: false },
    { event: { kind: "finished", sessionId: "s1" }, requireInteraction: false },
  ];
  for (const { event, requireInteraction } of kinds) {
    const p = buildPushPayload(event);
    expect(p.url).toBe("/?session=s1");
    expect(p.tag).toBe("s1");
    expect(p.renotify).toBe(true);
    expect(p.requireInteraction).toBe(requireInteraction);
    expect(typeof p.title).toBe("string");
    expect(p.title.length).toBeGreaterThan(0);
  }
  // detail enriches the body for file/ask.
  expect(buildPushPayload({ kind: "ask", sessionId: "s1", detail: "Pick one" }).body).toBe("Pick one");
  expect(buildPushPayload({ kind: "file", sessionId: "s1", detail: "shot.png" }).body).toBe("shot.png");
});

test("buildPushPayload carries badgeCount when the transport stamped it, and omits it otherwise", () => {
  expect(buildPushPayload({ kind: "awaiting", sessionId: "s1", badgeCount: 3 }).badgeCount).toBe(3);
  expect(buildPushPayload({ kind: "awaiting", sessionId: "s1", badgeCount: 0 }).badgeCount).toBe(0); // 0 → clear the badge
  expect(buildPushPayload({ kind: "finished", sessionId: "s1" }).badgeCount).toBeUndefined();
});

test("buildPushPayload for a `test` ping is session-less and never touches the badge", () => {
  const p = buildPushPayload({ kind: "test" });
  expect(p.title).toBe("remote-coder");
  expect(p.body).toContain("working");
  expect(p.url).toBe("/"); // no session deep-link
  expect(p.requireInteraction).toBe(false);
  expect(p.badgeCount).toBeUndefined(); // a test ping must not clobber the home-screen badge
});

test("dispatch fans a `test` ping out to EVERY subscription (global + session-scoped)", async () => {
  const store = fakeStore([sub("https://push/global"), sub("https://push/s1", "s1")]);
  const sent: string[] = [];
  const send: PushSendFn = async (s) => {
    sent.push(s.endpoint);
    return { statusCode: 201 };
  };
  const dispatcher = createPushDispatcher({ pushStore: store, send });
  await dispatcher.dispatch({ kind: "test" });
  expect(sent.sort()).toEqual(["https://push/global", "https://push/s1"]);
});

test("dispatch fans out to global + session-scoped subs and passes the JSON payload", async () => {
  const store = fakeStore([sub("https://push/global"), sub("https://push/s1", "s1"), sub("https://push/other", "s2")]);
  const sent: { endpoint: string; payload: string }[] = [];
  const send: PushSendFn = async (s, payload) => {
    sent.push({ endpoint: s.endpoint, payload });
    return { statusCode: 201 };
  };
  const dispatcher = createPushDispatcher({ pushStore: store, send });
  await dispatcher.dispatch({ kind: "awaiting", sessionId: "s1" });

  // The s2-scoped sub is NOT notified; the global + s1 subs are.
  expect(sent.map((x) => x.endpoint).sort()).toEqual(["https://push/global", "https://push/s1"]);
  expect(JSON.parse(sent[0]!.payload)).toMatchObject({ url: "/?session=s1", tag: "s1", requireInteraction: true });
});

test("dispatch prunes a sub on 404/410 but keeps a healthy one", async () => {
  const store = fakeStore([sub("https://push/dead"), sub("https://push/gone"), sub("https://push/live")]);
  const send: PushSendFn = async (s) => {
    if (s.endpoint === "https://push/dead") return { statusCode: 404 };
    if (s.endpoint === "https://push/gone") return { statusCode: 410 };
    return { statusCode: 201 };
  };
  const dispatcher = createPushDispatcher({ pushStore: store, send });
  await dispatcher.dispatch({ kind: "finished", sessionId: "s1" });
  expect(store.removed.sort()).toEqual(["https://push/dead", "https://push/gone"]);
});

test("dispatch never throws and does NOT prune on a non-HTTP send failure", async () => {
  const store = fakeStore([sub("https://push/x")]);
  const log = vi.fn();
  const send: PushSendFn = async () => {
    throw new Error("encryption failed"); // no statusCode → not known-dead
  };
  const dispatcher = createPushDispatcher({ pushStore: store, send, log });
  await expect(dispatcher.dispatch({ kind: "awaiting", sessionId: "s1" })).resolves.toBeUndefined();
  expect(store.removed).toEqual([]); // kept — a transient/crypto failure is not proof of death
  expect(log).toHaveBeenCalled();
});
