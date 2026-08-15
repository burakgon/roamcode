import type { ApiClient } from "../api/client";

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

function pushSupported(): boolean {
  return (
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
  api: Pick<ApiClient, "getVapidPublicKey" | "subscribePush">,
): Promise<"subscribed" | "unsubscribed" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  let existing = await reg.pushManager.getSubscription();
  // A subscription the Node can no longer sign for is worse than none: it is rejected with 403 on every
  // send, and re-registering the same endpoint cannot fix that. Drop it and fall through to a fresh one.
  if (existing && Notification.permission === "granted" && !readOptedOut()) {
    const publicKey = await api.getVapidPublicKey();
    if (!subscriptionMatchesKey(existing, publicKey)) {
      await existing.unsubscribe().catch(() => undefined);
      existing = null;
    }
  }
  // Ownership first, whatever the permission now says: an endpoint this browser still holds must follow the
  // CURRENT credential, so revoking this device also removes its push channel.
  if (existing) {
    await api.subscribePush(existing.toJSON());
    return Notification.permission === "denied" ? "denied" : "subscribed";
  }
  if (Notification.permission === "denied") return "denied";
  // Never turn push on for someone who has not asked for it: that opt-in is `enablePush`, from a gesture.
  if (Notification.permission !== "granted") return "unsubscribed";
  // ...nor for someone who asked for it once and then switched it off.
  if (readOptedOut()) return "unsubscribed";
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(await api.getVapidPublicKey()),
  });
  await api.subscribePush(sub.toJSON());
  return "subscribed";
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
  await api.unsubscribePush(sub.endpoint);
  await sub.unsubscribe();
}

/** Current subscription state for reflecting in the UI. */
export async function currentPushState(): Promise<"subscribed" | "unsubscribed" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "unsubscribed";
}
