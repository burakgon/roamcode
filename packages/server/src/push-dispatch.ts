// packages/server/src/push-dispatch.ts
import type { PushStore, PushSubscriptionRecord } from "./push-store.js";
import type { PushSendFn } from "./web-push-send.js";

/**
 * The "away-from-desk" events that warrant a phone push. This is the whole point of remote-coder: get
 * pinged when claude needs you (awaiting/ask), when it's done (finished), or when it hands you a file.
 */
export type PushEventKind = "awaiting" | "finished" | "file" | "ask";

export interface PushEvent {
  kind: PushEventKind;
  /** The session the event is about — becomes the deep-link (`/?session=<id>`) AND the notification tag. */
  sessionId: string;
  /** Optional enrichment: the file name (kind:"file") or the first question text (kind:"ask") for the body. */
  detail?: string;
}

/**
 * The Web Push payload the browser service worker consumes (packages/web `push` handler). The `tag` +
 * `renotify` pair COLLAPSES repeated pushes for the same session into one re-alerting notification (so a
 * flapping awaiting detector can't spam a phone), and `requireInteraction` keeps a "needs-you" alert
 * sticky while a "done"/"file" alert can auto-dismiss.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Deep-link the notification opens — always `/?session=<sessionId>`. */
  url: string;
  /** Notification tag = sessionId, so the OS collapses per-session alerts (with renotify) rather than stack. */
  tag: string;
  renotify: boolean;
  /** True for a waiting-for-user alert (awaiting/ask); false for a done/file alert. */
  requireInteraction: boolean;
}

export interface PushDispatcher {
  /**
   * Build the payload for an away-from-desk event and fan it out over every matching subscription. NEVER
   * throws (a push failure must never break the terminal / the calling route); dead subscriptions (404/410)
   * are pruned from the store as a side effect.
   */
  dispatch(event: PushEvent): Promise<void>;
}

/**
 * Map a semantic away-from-desk event to the Web Push payload the SW renders. Pure + exported so the exact
 * contract is unit-testable (and the web agents can match it): every payload deep-links to the session and
 * tags on the session id; only "needs-you" alerts (awaiting/ask) set requireInteraction.
 */
export function buildPushPayload(event: PushEvent): PushPayload {
  const base = { url: `/?session=${event.sessionId}`, tag: event.sessionId, renotify: true };
  switch (event.kind) {
    case "awaiting":
      return {
        ...base,
        title: "Claude is waiting",
        body: "Claude finished a turn and is waiting for you.",
        requireInteraction: true,
      };
    case "ask":
      return {
        ...base,
        title: "Claude has a question",
        body: event.detail ?? "Claude needs your input to continue.",
        requireInteraction: true,
      };
    case "file":
      return {
        ...base,
        title: "Claude sent a file",
        body: event.detail ?? "A file is ready in the Files panel.",
        requireInteraction: false,
      };
    case "finished":
      return {
        ...base,
        title: "Session ended",
        body: "Your Claude session has ended.",
        requireInteraction: false,
      };
  }
}

export interface CreatePushDispatcherDeps {
  pushStore: PushStore;
  /** The bound Web Push sender (createWebPushSend). Injected so tests drive a fake without real crypto/HTTP. */
  send: PushSendFn;
  /** Optional log sink for a non-HTTP send failure (defaults to a no-op). */
  log?: (msg: string) => void;
}

/**
 * Build the push dispatcher. Fans an event out to the GLOBAL subscriptions UNION the ones scoped to the
 * event's session (that's exactly what `pushStore.list({ sessionId })` returns), delivering to all in
 * parallel. A send that reports 404 (Not Found) / 410 (Gone) means the browser subscription is dead — it's
 * pruned from the store so it isn't retried forever. A non-HTTP failure (encryption, network throw) is
 * logged and the sub is KEPT (it isn't known-dead). Never throws.
 */
export function createPushDispatcher(deps: CreatePushDispatcherDeps): PushDispatcher {
  const { pushStore, send } = deps;

  async function deliverOne(sub: PushSubscriptionRecord, payload: string): Promise<void> {
    let result: { statusCode?: number };
    try {
      result = await send(sub, payload);
    } catch (err) {
      // A non-HTTP failure (e.g. encryption) — NOT proof the subscription is dead, so keep it; just log.
      deps.log?.(`push send failed for ${sub.endpoint}: ${(err as Error).message}`);
      return;
    }
    // 404/410 → the push service says this subscription no longer exists; prune it so we stop retrying.
    if (result.statusCode === 404 || result.statusCode === 410) pushStore.remove(sub.endpoint);
  }

  return {
    async dispatch(event) {
      const payload = JSON.stringify(buildPushPayload(event));
      // Global subs (no sessionId) + subs scoped to THIS session. A store read failure must not throw here.
      let subs: PushSubscriptionRecord[];
      try {
        subs = pushStore.list({ sessionId: event.sessionId });
      } catch (err) {
        deps.log?.(`push fan-out skipped (store list failed): ${(err as Error).message}`);
        return;
      }
      await Promise.all(subs.map((sub) => deliverOne(sub, payload)));
    },
  };
}
