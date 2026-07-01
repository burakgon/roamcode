import webpush from "web-push";
import type { VapidKeys } from "./vapid.js";

export interface PushRecipient {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendFn = (sub: PushRecipient, payload: string) => Promise<{ statusCode?: number }>;

export interface CreateWebPushSendOptions {
  vapid: VapidKeys;
  /** VAPID subject: a mailto: or https: URL the push service can contact (web-push requires it). */
  subject: string;
}

/**
 * Bind a real Web Push sender. Maps our flat PushSubscriptionRecord to the {endpoint, keys} shape
 * web-push.sendNotification expects, and normalizes the outcome to { statusCode } so the dispatcher
 * can prune on 404/410 without depending on web-push's error type.
 */
export function createWebPushSend(opts: CreateWebPushSendOptions): PushSendFn {
  webpush.setVapidDetails(opts.subject, opts.vapid.publicKey, opts.vapid.privateKey);
  return async (sub, payload) => {
    try {
      const res = await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      return { statusCode: res.statusCode };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (typeof status === "number") return { statusCode: status };
      throw err; // a non-HTTP failure (e.g. encryption) — let the dispatcher swallow it
    }
  };
}
