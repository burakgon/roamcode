import type { ApiClient, PushTestResult } from "../api/client";
import { isIosLikePlatform } from "./platform";
import { isPushTestResultMessage } from "../sw-handlers";

export type PushSubscribeResult = "subscribed" | "denied" | "unsupported";

/** VAPID public key (url-safe base64) → the Uint8Array the PushManager wants as applicationServerKey. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Back the view with a concrete ArrayBuffer (never SharedArrayBuffer) so it satisfies the
  // BufferSource that PushManager.subscribe expects for applicationServerKey.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * "This user switched notifications OFF here." Unsubscribing leaves the OS permission `granted`, so without
 * a record of the user's own choice the boot heal below would read that granted permission as consent and
 * silently switch push back on.
 */
const OPT_OUT_KEY = "roamcode.push-opt-out";

function readOptedOut(): boolean {
  try {
    return window.localStorage?.getItem(OPT_OUT_KEY) === "1";
  } catch {
    // Storage blocked (private mode): prefer healing a broken subscription over honouring a preference we
    // cannot read — the user can always turn it off again.
    return false;
  }
}

function writeOptedOut(value: boolean): void {
  try {
    if (value) window.localStorage?.setItem(OPT_OUT_KEY, "1");
    else window.localStorage?.removeItem(OPT_OUT_KEY);
  } catch {
    /* storage blocked — the preference just isn't remembered */
  }
}

/** Whether an existing subscription was created against `publicKey` — i.e. whether the Node can still sign
 *  for it. A subscription is bound for life to the application server key it was made with, so once the
 *  Node's VAPID key differs, every push to that endpoint is rejected with 403 and only a NEW subscription
 *  can recover it. An engine that does not expose the key is treated as a match: replacing a subscription
 *  we cannot check would drop a working one. */
function subscriptionMatchesKey(sub: PushSubscription, publicKey: string): boolean {
  const applied = sub.options?.applicationServerKey;
  if (!applied) return true;
  const current = urlBase64ToUint8Array(publicKey);
  const existing = new Uint8Array(applied);
  return existing.length === current.length && existing.every((byte, i) => byte === current[i]);
}

/** iOS/iPadOS only expose Web Push as a Home Screen web-app feature. Treating a Safari tab as generically
 *  supported leads to a permission flow that can never create a working iPhone subscription. */
export function isIosNonStandalone(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (!isIosLikePlatform(navigator.userAgent || "", navigator.maxTouchPoints || 0)) return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return !Boolean(nav.standalone) && !Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
}

function pushSupported(): boolean {
  return (
    !isIosNonStandalone() &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Subscribe this device to Web Push. Requests notification permission (the explicit opt-in — only
 * call this from a user gesture), subscribes via the SW registration with the server's VAPID key,
 * and registers the subscription server-side. Returns the resulting state.
 */
export async function enablePush(
  api: Pick<ApiClient, "getVapidPublicKey" | "subscribePush">,
): Promise<PushSubscribeResult> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const publicKey = await api.getVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api.subscribePush(sub.toJSON());
  writeOptedOut(false);
  return "subscribed";
}

/**
 * Heal push on boot, for a user who already granted permission.
 *
 * A PushSubscription belongs to the SERVICE-WORKER REGISTRATION, and RoamCode unregisters that
 * registration on every stale-bundle recovery path — the automatic self-heal after an OTA update
 * (`hardRefresh`), the iOS `prepareForAppReopen`, the service worker's own iOS activate branch, and the
 * "Reload"/"Refresh" buttons. Each of those quietly destroyed the subscription, and boot only ever
 * re-registered a subscription that still EXISTED — so push simply stopped after an update while the app
 * went on looking perfectly healthy. Browsers also rotate subscriptions on their own, with the same result.
 *
 * Re-subscribing here never prompts — permission is already `granted`, so `subscribe()` resolves silently —
 * and it is the only place that can talk to the server, because the service worker holds no credential.
 */
export async function restorePushSubscription(
  api: Pick<ApiClient, "getVapidPublicKey" | "subscribePush"> & Partial<Pick<ApiClient, "unsubscribePush">>,
): Promise<"subscribed" | "unsubscribed" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  let existing = await reg.pushManager.getSubscription();
  const removeExisting = async () => {
    if (!existing) return;
    // Server cleanup is best-effort so a transient API error never prevents local recovery. The dispatcher
    // independently prunes a VapidPkHashMismatch response if this request could not reach the Node.
    await api.unsubscribePush?.(existing.endpoint).catch(() => undefined);
    await existing.unsubscribe().catch(() => undefined);
    existing = null;
  };
  // Check explicit opt-out and permission BEFORE re-registering ownership. The old ordering could resurrect
  // an endpoint after the user switched notifications off, especially when local unsubscribe had failed.
  if (readOptedOut()) {
    await removeExisting();
    return "unsubscribed";
  }
  if (Notification.permission === "denied") {
    await removeExisting();
    return "denied";
  }
  // A subscription the Node can no longer sign for is worse than none: it is rejected with 403 on every
  // send, and re-registering the same endpoint cannot fix that. Drop it and fall through to a fresh one.
  if (existing && Notification.permission === "granted") {
    const publicKey = await api.getVapidPublicKey();
    if (!subscriptionMatchesKey(existing, publicKey)) {
      await removeExisting();
    }
  }
  // Ownership first, whatever the permission now says: an endpoint this browser still holds must follow the
  // CURRENT credential, so revoking this device also removes its push channel.
  if (existing) {
    await api.subscribePush(existing.toJSON());
    return "subscribed";
  }
  // Never turn push on for someone who has not asked for it: that opt-in is `enablePush`, from a gesture.
  if (Notification.permission !== "granted") return "unsubscribed";
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(await api.getVapidPublicKey()),
  });
  await api.subscribePush(sub.toJSON());
  return "subscribed";
}

/** Retry transient boot-heal failures instead of silently giving up until the next full app launch. */
export async function restorePushSubscriptionWithRetry(
  api: Pick<ApiClient, "getVapidPublicKey" | "subscribePush"> & Partial<Pick<ApiClient, "unsubscribePush">>,
  options: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<"subscribed" | "unsubscribed" | "denied" | "unsupported"> {
  const delays = options.delaysMs ?? [1_000, 5_000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await restorePushSubscription(api);
    } catch (error) {
      lastError = error;
      const delay = delays[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Unsubscribe this device (locally + server-side). Safe to call when not subscribed. */
export async function disablePush(api: Pick<ApiClient, "unsubscribePush">): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  // Remember the choice even with no live subscription: the OS permission stays granted either way, and it
  // is the only thing that keeps the boot heal from treating that permission as consent.
  writeOptedOut(true);
  if (!sub) return;
  try {
    await api.unsubscribePush(sub.endpoint);
  } finally {
    // A temporarily unreachable Node must not override the user's local opt-out.
    await sub.unsubscribe();
  }
}

/** Current subscription + web permission state for reflecting in the UI. iOS does not expose a separate
 * system-level notification switch, so Settings copy covers that case after a successful worker ack. */
export async function currentPushState(): Promise<"subscribed" | "unsubscribed" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (readOptedOut()) return "unsubscribed";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "unsubscribed";
}

export interface CurrentDevicePushTestResult extends PushTestResult {
  /** `shown` means this service worker's showNotification() resolved; `unconfirmed` means only HTTP 2xx. */
  display?: "shown" | "failed" | "unconfirmed";
}

function waitForPushTestResult(
  serviceWorker: Pick<ServiceWorkerContainer, "addEventListener" | "removeEventListener">,
  testId: string,
  timeoutMs: number,
): { promise: Promise<"shown" | "failed" | "unconfirmed">; cancel: () => void } {
  let finish!: (result: "shown" | "failed" | "unconfirmed") => void;
  const promise = new Promise<"shown" | "failed" | "unconfirmed">((resolve) => {
    let settled = false;
    const onMessage = (event: MessageEvent) => {
      if (!isPushTestResultMessage(event.data) || event.data.testId !== testId) return;
      finish(event.data.result);
    };
    const timer = window.setTimeout(() => finish("unconfirmed"), timeoutMs);
    finish = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      serviceWorker.removeEventListener("message", onMessage as EventListener);
      resolve(result);
    };
    serviceWorker.addEventListener("message", onMessage as EventListener);
  });
  return { promise, cancel: () => finish("unconfirmed") };
}

/**
 * Test THIS browser's live subscription, not an arbitrary row in the Node's store. Re-upserting first
 * refreshes endpoint encryption keys/ownership; the correlated service-worker response proves decryption and
 * showNotification(), while a timeout is reported honestly as push-service acceptance only.
 */
export async function sendPushTestToCurrentDevice(
  api: Pick<ApiClient, "subscribePush" | "sendPushTest">,
  options: { testId?: string; confirmationTimeoutMs?: number } = {},
): Promise<CurrentDevicePushTestResult> {
  if (!pushSupported()) return { ok: false, reason: "push is unavailable on this device" };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return { ok: false, reason: "this device is not subscribed; enable notifications and retry" };

  // This is deliberately immediately before the test: an endpoint retained in SQLite does not prove that
  // this registration still owns it, and stale p256dh/auth values can be accepted before decryption fails.
  await api.subscribePush(subscription.toJSON());
  const testId =
    options.testId ??
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const confirmation = waitForPushTestResult(navigator.serviceWorker, testId, options.confirmationTimeoutMs ?? 8_000);
  let result: PushTestResult;
  try {
    result = await api.sendPushTest(subscription.endpoint, testId);
  } catch (error) {
    confirmation.cancel();
    throw error;
  }
  if (!result.ok) {
    confirmation.cancel();
    return result;
  }
  return { ...result, display: await confirmation.promise };
}
