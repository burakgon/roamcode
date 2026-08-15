import { afterEach, describe, expect, it, vi } from "vitest";
import { urlBase64ToUint8Array, enablePush, disablePush, restorePushSubscription } from "./push";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

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

describe("restorePushSubscription", () => {
  /** A registration whose pushManager reports `existing` and records any new subscribe() call. */
  function stubRegistration(existing: unknown) {
    const created = { toJSON: () => ({ endpoint: "https://push.example/recreated" }) };
    const subscribe = vi.fn().mockResolvedValue(created);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(existing), subscribe },
        }),
      },
    });
    vi.stubGlobal("PushManager", class PushManager {});
    return { subscribe };
  }

  it("re-creates a subscription destroyed by an update, without prompting again", async () => {
    // Every stale-bundle recovery path unregisters the service worker, and the Push subscription belongs to
    // that registration — so an ordinary OTA update silently ended push and nothing ever re-created it.
    const { subscribe } = stubRegistration(null);
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    const subscribePush = vi.fn().mockResolvedValue(undefined);
    const getVapidPublicKey = vi.fn().mockResolvedValue("AQID");

    const result = await restorePushSubscription({ getVapidPublicKey, subscribePush });

    expect(result).toBe("subscribed");
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "https://push.example/recreated" });
    // Permission is already granted; re-subscribing must never re-prompt.
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("keeps an existing subscription and only re-registers its owner", async () => {
    const existing = { toJSON: () => ({ endpoint: "https://push.example/device" }) };
    const { subscribe } = stubRegistration(existing);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const subscribePush = vi.fn().mockResolvedValue(undefined);

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn().mockResolvedValue("AQID"),
      subscribePush,
    });

    expect(result).toBe("subscribed");
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "https://push.example/device" });
  });

  it("never subscribes a user who has not granted permission", async () => {
    const { subscribe } = stubRegistration(null);
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    const subscribePush = vi.fn();

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn(),
      subscribePush,
    });

    expect(result).toBe("unsubscribed");
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).not.toHaveBeenCalled();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it("reports denied permission rather than silently claiming push works", async () => {
    stubRegistration(null);
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn(),
      subscribePush: vi.fn(),
    });

    expect(result).toBe("denied");
  });

  it("does not resurrect push for someone who deliberately turned it off", async () => {
    // Turning notifications off in Settings unsubscribes but leaves the OS permission granted, so the boot
    // heal would otherwise silently switch them back on — the opposite of what the user asked for.
    const { subscribe } = stubRegistration(null);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const subscribePush = vi.fn();
    await disablePush({ unsubscribePush: vi.fn().mockResolvedValue(undefined) });

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn(),
      subscribePush,
    });

    expect(result).toBe("unsubscribed");
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it("heals again once the user opts back in", async () => {
    const { subscribe } = stubRegistration(null);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn().mockResolvedValue("granted") });
    const api = {
      getVapidPublicKey: vi.fn().mockResolvedValue("AQID"),
      subscribePush: vi.fn().mockResolvedValue(undefined),
    };
    await disablePush({ unsubscribePush: vi.fn().mockResolvedValue(undefined) });
    await enablePush(api);

    expect(await restorePushSubscription(api)).toBe("subscribed");
    expect(subscribe).toHaveBeenCalled();
  });
});
