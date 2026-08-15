import webpush from "web-push";
import type { VapidKeys } from "./vapid.js";

export interface PushRecipient {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendFn = (
  sub: PushRecipient,
  payload: string,
) => Promise<{
  statusCode?: number;
  /** The push service's own explanation, verbatim. A 403 is ambiguous without it: Apple answers
   *  "BadJwtToken" for a VAPID subject it rejects and "VapidPkHashMismatch" when the subscription was made
   *  against a different application server key — opposite problems, opposite fixes. */
  reason?: string;
}>;

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
      const { statusCode: status, body } = err as { statusCode?: number; body?: unknown };
      if (typeof status === "number") {
        return { statusCode: status, ...(typeof body === "string" && body ? { reason: body } : {}) };
      }
      throw err; // a non-HTTP failure (e.g. encryption) — let the dispatcher swallow it
    }
  };
}
