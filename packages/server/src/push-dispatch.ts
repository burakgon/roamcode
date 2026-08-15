// packages/server/src/push-dispatch.ts
import type { PushStore, PushSubscriptionRecord } from "./push-store.js";
import type { PushSendFn } from "./web-push-send.js";
import type { ProviderId } from "./providers/types.js";

/**
 * The "away-from-desk" events that warrant a phone push. This is the whole point of roamcode: get
 * pinged when claude needs you (awaiting), when it's done (finished), or when it hands you a file.
 * "test" is the odd one out — a user-triggered "are notifications working?" ping (POST /push/test), which
 * carries no session and never touches the home-screen badge.
 */
export type PushEventKind = "awaiting" | "finished" | "file" | "test" | "dismiss";

export interface PushEvent {
  kind: PushEventKind;
  /** The session the event is about — becomes the deep-link (`/?session=<id>`) AND the notification tag.
   *  Absent for a "test" ping (which isn't about any session). */
  sessionId?: string;
  /** Optional enrichment: the file name (kind:"file") for the body. */
  detail?: string;
  /** Provider/session identity is bounded display metadata, never an auth or protocol payload. */
  provider?: ProviderId;
  label?: string;
  /**
   * Home-screen app-badge value = the count of sessions currently awaiting you. Stamped by the transport on
   * every real dispatch (awaiting/finished/file) from {@link TerminalManager.awaitingCount}, so the SW
   * can keep the badge in sync with "how many sessions need you". Omitted for a "test" ping (it must never
   * clobber the badge). A missing value leaves the badge untouched on the client.
   */
  badgeCount?: number;
  /** Opaque one-shot correlation id for a user-triggered test. The service worker echoes it to the open
   *  client only after showNotification() resolves, distinguishing push-service acceptance from display. */
  testId?: string;
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
  /** True for a waiting-for-user alert (awaiting); false for a done/file alert. */
  requireInteraction: boolean;
  /**
   * The home-screen app-badge value the SW should apply (applyBadgeFromPush): the count of sessions currently
   * awaiting you. Present on every real away-from-desk payload; ABSENT on a "test" ping (so it never clobbers
   * the badge). The SW treats a missing value as "leave the badge alone" and 0 as "clear it". Android/desktop
   * honor the app badge; iOS can't badge from a push.
   */
  badgeCount?: number;
  /** Present only on a current-device test so the open client can confirm the service worker handled it. */
  testId?: string;
  /** Take the notification carrying `tag` off this device's screen instead of showing anything. Sent when
   *  the reason for it was handled somewhere else, so a question already answered on one device stops
   *  waiting on every other. */
  dismiss?: true;
}

/** Why one push service did not accept the message for a subscription. */
export interface PushDeliveryFailure {
  endpoint: string;
  /** The push service's HTTP status, when it answered (403 BadJwtToken, 400, 429, 410 Gone…). */
  statusCode?: number;
  /** A non-HTTP failure (encryption, DNS, socket) — no status to report. */
  message?: string;
  /** The push service's own explanation for a rejection (e.g. "BadJwtToken", "VapidPkHashMismatch"). */
  reason?: string;
}

/**
 * The outcome of one fan-out at the push-service boundary. A 2xx is acceptance for delivery; only the
 * browser/service worker can subsequently confirm that the encrypted payload was handled and displayed.
 */
export interface PushDeliveryReport {
  attempted: number;
  /** Number of 2xx responses from push services. This is acceptance for delivery, not device display. */
  delivered: number;
  failures: PushDeliveryFailure[];
}

export interface PushDispatchOptions {
  /** Restrict this dispatch to one exact browser subscription (used by POST /push/test). */
  endpoint?: string;
}

export interface PushDispatcher {
  /**
   * Build the payload for an away-from-desk event and fan it out over every matching subscription. NEVER
   * throws (a push failure must never break the terminal / the calling route); known-dead subscriptions are
   * pruned from the store as a side effect. Resolves with push-service acceptance/failure counts.
   */
  dispatch(event: PushEvent, options?: PushDispatchOptions): Promise<PushDeliveryReport>;
}

function providerDisplayName(provider: ProviderId | undefined): string {
  if (!provider || provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(provider)) return "Agent";
  return provider
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/**
 * Map a semantic away-from-desk event to the Web Push payload the SW renders. Pure + exported so the exact
 * contract is unit-testable (and the web agents can match it): every payload deep-links to the session and
 * tags on the session id; only "needs-you" alerts (awaiting) set requireInteraction.
 */
export function buildPushPayload(event: PushEvent): PushPayload {
  // A user-triggered "are notifications working?" ping (POST /push/test): fixed copy, opens the app root (no
  // session), never sticky, and DELIBERATELY carries no badgeCount so it can't clobber the home-screen badge.
  if (event.kind === "test") {
    return {
      title: "roamcode",
      body: "Notifications are working ✓",
      url: "/",
      tag: "roamcode-test",
      renotify: true,
      requireInteraction: false,
      ...(event.testId ? { testId: event.testId } : {}),
    };
  }
  // Handled elsewhere: the worker closes the notification tagged with this session and shows nothing. The
  // title/body are never displayed; they exist so a browser that insists on rendering something is coherent.
  if (event.kind === "dismiss") {
    return {
      title: "RoamCode",
      body: "Handled on another device.",
      url: `/?session=${event.sessionId}`,
      tag: event.sessionId ?? "",
      renotify: false,
      requireInteraction: false,
      dismiss: true,
      ...(typeof event.badgeCount === "number" ? { badgeCount: event.badgeCount } : {}),
    };
  }
  // Every real away-from-desk payload deep-links to the session, tags on the session id, and — when the
  // transport stamped it — carries the awaiting-session count as `badgeCount` (0 included, so the SW can
  // CLEAR the badge when nothing is left waiting).
  const base = {
    url: `/?session=${event.sessionId}`,
    tag: event.sessionId ?? "",
    renotify: true,
    ...(typeof event.badgeCount === "number" ? { badgeCount: event.badgeCount } : {}),
  };
  const provider = providerDisplayName(event.provider);
  const safeLabel = (() => {
    const clean = event.label
      ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .trim()
      .slice(0, 80);
    return clean || "Session";
  })();
  switch (event.kind) {
    case "awaiting":
      return {
        ...base,
        title: `${provider} is waiting`,
        body: `${safeLabel} needs your input in ${provider}.`,
        requireInteraction: true,
      };
    case "file":
      return {
        ...base,
        title: `${provider} sent a file`,
        body: `${safeLabel} has a file ready in the Files panel.`,
        requireInteraction: false,
      };
    case "finished":
      return {
        ...base,
        title: `${provider} finished`,
        body: `${safeLabel} finished its current task in ${provider}.`,
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

  function endpointHost(endpoint: string): string {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return "invalid push endpoint";
    }
  }

  async function deliverOne(sub: PushSubscriptionRecord, payload: string): Promise<PushDeliveryFailure | undefined> {
    let result: { statusCode?: number; reason?: string };
    try {
      result = await send(sub, payload);
    } catch (err) {
      // A non-HTTP failure (e.g. encryption) — NOT proof the subscription is dead, so keep it; just log.
      const message = (err as Error).message;
      deps.log?.(`push send failed for ${endpointHost(sub.endpoint)}: ${message}`);
      return { endpoint: sub.endpoint, message };
    }
    // 404/410 → the push service says this subscription no longer exists. Apple's VapidPkHashMismatch is
    // equally terminal for this endpoint: a subscription is permanently bound to its original VAPID key.
    // Do NOT prune an arbitrary 403 (BadJwtToken can instead mean a server-wide subject/config problem).
    const staleVapidSubscription = result.statusCode === 403 && result.reason?.includes("VapidPkHashMismatch") === true;
    if (result.statusCode === 404 || result.statusCode === 410 || staleVapidSubscription) {
      pushStore.remove(sub.endpoint);
      return {
        endpoint: sub.endpoint,
        statusCode: result.statusCode,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    }
    // Anything else outside 2xx is a REJECTION we used to discard entirely — no log, no report — which left
    // "notifications never arrive" with no evidence anywhere. Apple answers 403 for a VAPID subject it will
    // not accept; a 429 means we are being throttled. Keep the subscription (it is not known-dead) and say so.
    const status = result.statusCode;
    if (typeof status === "number" && (status < 200 || status >= 300)) {
      deps.log?.(
        `push rejected for ${endpointHost(sub.endpoint)}: HTTP ${status}${result.reason ? ` ${result.reason}` : ""}`,
      );
      return { endpoint: sub.endpoint, statusCode: status, ...(result.reason ? { reason: result.reason } : {}) };
    }
    return undefined;
  }

  return {
    async dispatch(event, options) {
      const payload = JSON.stringify(buildPushPayload(event));
      // Global subs (no sessionId) + subs scoped to THIS session. A current-device test supplies an exact
      // endpoint option after the list; ordinary away-from-desk events retain their normal fan-out. A store
      // read failure must not throw here.
      let subs: PushSubscriptionRecord[];
      try {
        subs = pushStore.list({ sessionId: event.sessionId });
        if (options?.endpoint) subs = subs.filter((sub) => sub.endpoint === options.endpoint);
      } catch (err) {
        const message = (err as Error).message;
        deps.log?.(`push fan-out skipped (store list failed): ${message}`);
        return { attempted: 0, delivered: 0, failures: [{ endpoint: "", message }] };
      }
      const outcomes = await Promise.all(subs.map((sub) => deliverOne(sub, payload)));
      const failures = outcomes.filter((outcome): outcome is PushDeliveryFailure => outcome !== undefined);
      return { attempted: subs.length, delivered: subs.length - failures.length, failures };
    },
  };
}
