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

test("buildPushPayload deep-links + tags on the session and only awaiting requires interaction", () => {
  const kinds: { event: PushEvent; requireInteraction: boolean }[] = [
    { event: { kind: "awaiting", sessionId: "s1" }, requireInteraction: true },
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
  // Raw detail is not copied into a lock-screen payload.
  expect(buildPushPayload({ kind: "file", sessionId: "s1", detail: "shot.png" }).body).not.toContain("shot.png");
});

test("buildPushPayload carries badgeCount when the transport stamped it, and omits it otherwise", () => {
  expect(buildPushPayload({ kind: "awaiting", sessionId: "s1", badgeCount: 3 }).badgeCount).toBe(3);
  expect(buildPushPayload({ kind: "awaiting", sessionId: "s1", badgeCount: 0 }).badgeCount).toBe(0); // 0 → clear the badge
  expect(buildPushPayload({ kind: "finished", sessionId: "s1" }).badgeCount).toBeUndefined();
});

test("provider-labels awaiting, finished, and file copy without exposing raw detail", () => {
  const events: PushEvent[] = [
    { kind: "awaiting", sessionId: "s1", provider: "codex", label: "Payments" },
    { kind: "finished", sessionId: "s1", provider: "codex", label: "Payments" },
    {
      kind: "file",
      sessionId: "s1",
      provider: "codex",
      label: "Payments",
      detail: "/private/secrets/customer-list.csv",
    },
  ];
  for (const event of events) {
    const payload = buildPushPayload(event);
    expect(`${payload.title} ${payload.body}`).toMatch(/codex/i);
    expect(`${payload.title} ${payload.body}`).toContain("Payments");
    expect(`${payload.title} ${payload.body}`).not.toMatch(/private|secrets|customer-list/i);
  }
  expect(buildPushPayload(events[1]!)).toMatchObject({
    title: "Codex finished",
    body: "Payments finished its current task in Codex.",
  });
});

test("unsupported legacy runtime pushes keep their provider identity", () => {
  const payload = buildPushPayload({
    kind: "awaiting",
    sessionId: "s-review",
    provider: "review-agent",
    label: "Pull request 42",
  });
  expect(payload.title).toBe("Review Agent is waiting");
  expect(payload.body).toBe("Pull request 42 needs your input in Review Agent.");
  expect(`${payload.title} ${payload.body}`).not.toMatch(/Claude|Codex/);
});

test("strips Unicode controls, bidi formatting, and line separators from push labels", () => {
  const payload = buildPushPayload({
    kind: "awaiting",
    sessionId: "s1",
    provider: "codex",
    label: "Pay\u0000\u202Ements\u2028secret\u2066",
  });
  expect(payload.body).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  expect(payload.body).toContain("Paymentssecret");
});

test("buildPushPayload for a `test` ping is session-less and never touches the badge", () => {
  const p = buildPushPayload({ kind: "test" });
  expect(p.title).toBe("roamcode");
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
  // dispatch now RESOLVES WITH the outcome instead of void, so a caller can tell delivery from mere attempt.
  await expect(dispatcher.dispatch({ kind: "awaiting", sessionId: "s1" })).resolves.toMatchObject({
    attempted: 1,
    delivered: 0,
  });
  expect(store.removed).toEqual([]); // kept — a transient/crypto failure is not proof of death
  expect(log).toHaveBeenCalled();
});

test("a push the service REJECTS is reported and logged, not silently discarded", async () => {
  // Only 404/410 were ever inspected. Every other rejection — Apple's 403 BadJwtToken, a 400, a 429 —
  // was dropped on the floor: nothing logged, nothing pruned, nothing reported. "I get no notifications"
  // was therefore undiagnosable from either the logs or the app.
  const store = fakeStore([sub("https://push.example/alive"), sub("https://push.example/rejected")]);
  const logs: string[] = [];
  const send: PushSendFn = vi.fn(async (recipient) =>
    recipient.endpoint.endsWith("rejected") ? { statusCode: 403 } : { statusCode: 201 },
  );
  const dispatcher = createPushDispatcher({ pushStore: store, send, log: (m) => logs.push(m) });

  const report = await dispatcher.dispatch({ kind: "test" });

  expect(report).toMatchObject({ attempted: 2, delivered: 1 });
  expect(report.failures).toEqual([{ endpoint: "https://push.example/rejected", statusCode: 403 }]);
  expect(logs.join("\n")).toContain("403");
  // A rejection that isn't 404/410 is not proof the subscription is dead, so it must be KEPT.
  expect(store.removed).toEqual([]);
});

test("counts a successful fan-out so a caller can say whether anything was delivered", async () => {
  const store = fakeStore([sub("https://push.example/a"), sub("https://push.example/b")]);
  const send: PushSendFn = vi.fn(async () => ({ statusCode: 201 }));
  const dispatcher = createPushDispatcher({ pushStore: store, send });

  const report = await dispatcher.dispatch({ kind: "test" });

  expect(report).toEqual({ attempted: 2, delivered: 2, failures: [] });
});

test("a dead subscription is pruned AND reported", async () => {
  const store = fakeStore([sub("https://push.example/gone")]);
  const send: PushSendFn = vi.fn(async () => ({ statusCode: 410 }));
  const dispatcher = createPushDispatcher({ pushStore: store, send });

  const report = await dispatcher.dispatch({ kind: "test" });

  expect(store.removed).toEqual(["https://push.example/gone"]);
  expect(report).toMatchObject({ attempted: 1, delivered: 0 });
  expect(report.failures[0]).toMatchObject({ statusCode: 410 });
});

test("a non-HTTP send failure is still reported rather than vanishing", async () => {
  const store = fakeStore([sub("https://push.example/boom")]);
  const send: PushSendFn = vi.fn(async () => {
    throw new Error("encryption failed");
  });
  const logs: string[] = [];
  const dispatcher = createPushDispatcher({ pushStore: store, send, log: (m) => logs.push(m) });

  const report = await dispatcher.dispatch({ kind: "test" });

  expect(report).toMatchObject({ attempted: 1, delivered: 0 });
  expect(report.failures[0]).toMatchObject({ message: "encryption failed" });
  expect(logs.join("\n")).toContain("encryption failed");
  expect(store.removed).toEqual([]);
});
