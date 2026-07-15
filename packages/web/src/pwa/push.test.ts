import { afterEach, describe, expect, it, vi } from "vitest";
import { urlBase64ToUint8Array, enablePush, syncExistingPushOwner } from "./push";

afterEach(() => vi.unstubAllGlobals());

describe("urlBase64ToUint8Array", () => {
  it("decodes a url-safe base64 VAPID key to bytes", () => {
    // "AQID" is base64 for [1,2,3]; url-safe + no padding handled internally.
    const bytes = urlBase64ToUint8Array("AQID");
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
  it("handles url-safe chars (- and _) and missing padding", () => {
    // Should not throw on a realistic key alphabet.
    expect(() => urlBase64ToUint8Array("BNc-_key0123ABCdef")).not.toThrow();
  });
});

describe("enablePush", () => {
  it("returns 'unsupported' when the browser lacks Push/ServiceWorker", async () => {
    const api = { getVapidPublicKey: async () => "AQID", subscribePush: async () => undefined };
    // jsdom has no real serviceWorker/PushManager → unsupported.
    const result = await enablePush(api);
    expect(result).toBe("unsupported");
  });
});

describe("syncExistingPushOwner", () => {
  it("re-registers an existing endpoint without requesting permission", async () => {
    const subscription = { toJSON: vi.fn(() => ({ endpoint: "https://push.example/device" })) };
    const subscribePush = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }) },
    });
    vi.stubGlobal("PushManager", class PushManager {});
    vi.stubGlobal("Notification", { requestPermission: vi.fn() });

    await syncExistingPushOwner({ subscribePush });

    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "https://push.example/device" });
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });
});
