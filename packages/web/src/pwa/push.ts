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
  return "subscribed";
}

/**
 * Re-register an EXISTING browser subscription with the credential currently used by the API client.
 * This never prompts and never creates a subscription: it only lets the server attach an old/unowned
 * endpoint to a newly issued per-device key, so revoking that device also removes its push channel.
 */
export async function syncExistingPushOwner(api: Pick<ApiClient, "subscribePush">): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await api.subscribePush(sub.toJSON());
}

/** Unsubscribe this device (locally + server-side). Safe to call when not subscribed. */
export async function disablePush(api: Pick<ApiClient, "unsubscribePush">): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
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
