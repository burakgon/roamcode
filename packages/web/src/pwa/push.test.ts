import { afterEach, describe, expect, it, vi } from "vitest";
import {
  urlBase64ToUint8Array,
  enablePush,
  disablePush,
  restorePushSubscription,
  restorePushSubscriptionWithRetry,
  sendPushTestToCurrentDevice,
  isIosNonStandalone,
  currentPushState,
} from "./push";
import { PUSH_TEST_RESULT_MESSAGE } from "../sw-handlers";

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

  it("replaces a subscription made against a DIFFERENT application server key", async () => {
    // A subscription is permanently bound to the VAPID public key it was created with. If the Node's key
    // ever changes, that endpoint is rejected with 403 (VapidPkHashMismatch) forever — and re-registering
    // the same dead endpoint, which is all boot used to do, can never recover it.
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const stale = {
      endpoint: "https://push.example/stale",
      toJSON: () => ({ endpoint: "https://push.example/stale" }),
      // "AQID" decodes to [1,2,3]; the server below now signs with a different key.
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      unsubscribe,
    };
    const { subscribe } = stubRegistration(stale);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const subscribePush = vi.fn().mockResolvedValue(undefined);
    const unsubscribePush = vi.fn().mockResolvedValue(undefined);

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn().mockResolvedValue("BAUG"), // decodes to [4,5,6]
      subscribePush,
      unsubscribePush,
    });

    expect(result).toBe("subscribed");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribePush).toHaveBeenCalledWith("https://push.example/stale");
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "https://push.example/recreated" });
  });

  it("keeps a subscription whose key still matches the Node", async () => {
    const unsubscribe = vi.fn();
    const current = {
      toJSON: () => ({ endpoint: "https://push.example/device" }),
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      unsubscribe,
    };
    const { subscribe } = stubRegistration(current);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const subscribePush = vi.fn().mockResolvedValue(undefined);

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn().mockResolvedValue("AQID"), // the same [1,2,3]
      subscribePush,
    });

    expect(result).toBe("subscribed");
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribePush).toHaveBeenCalledWith({ endpoint: "https://push.example/device" });
  });

  it("checks persisted opt-out before re-registering an existing endpoint", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const existing = {
      endpoint: "https://push.example/left-behind",
      toJSON: () => ({ endpoint: "https://push.example/left-behind" }),
      unsubscribe,
    };
    const { subscribe } = stubRegistration(existing);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    localStorage.setItem("roamcode.push-opt-out", "1");
    const subscribePush = vi.fn();
    const unsubscribePush = vi.fn().mockResolvedValue(undefined);

    const result = await restorePushSubscription({
      getVapidPublicKey: vi.fn(),
      subscribePush,
      unsubscribePush,
    });

    expect(result).toBe("unsubscribed");
    expect(subscribePush).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribePush).toHaveBeenCalledWith(existing.endpoint);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("retries a transient boot-heal failure", async () => {
    const { subscribe } = stubRegistration(null);
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const subscribePush = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await restorePushSubscriptionWithRetry(
      { getVapidPublicKey: vi.fn().mockResolvedValue("AQID"), subscribePush },
      { delaysMs: [1, 2], sleep },
    );

    expect(result).toBe("subscribed");
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(subscribePush).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1);
    expect(sleep).toHaveBeenNthCalledWith(2, 2);
  });
});

describe("current-device push test", () => {
  it("refreshes the current subscription, targets its endpoint, and waits for the worker confirmation", async () => {
    const subscription = {
      endpoint: "https://web.push.apple.com/current",
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/current",
        keys: { p256dh: "current-key", auth: "current-auth" },
      }),
    };
    let messageListener: EventListener | undefined;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }),
        addEventListener: vi.fn((_type: string, listener: EventListener) => {
          messageListener = listener;
        }),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal("PushManager", class PushManager {});
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const subscribePush = vi.fn().mockResolvedValue(undefined);
    const sendPushTest = vi.fn(async (_endpoint: string | undefined, testId: string | undefined) => {
      queueMicrotask(() =>
        messageListener?.(
          new MessageEvent("message", {
            data: { type: PUSH_TEST_RESULT_MESSAGE, testId, result: "shown" },
          }),
        ),
      );
      return { ok: true, attempted: 1, delivered: 1 };
    });

    const result = await sendPushTestToCurrentDevice(
      { subscribePush, sendPushTest },
      { testId: "test-current", confirmationTimeoutMs: 50 },
    );

    expect(subscribePush).toHaveBeenCalledWith(subscription.toJSON());
    expect(sendPushTest).toHaveBeenCalledWith(subscription.endpoint, "test-current");
    expect(result).toMatchObject({ ok: true, display: "shown" });
  });

  it("reports an accepted push as unconfirmed when the service worker never answers", async () => {
    const subscription = {
      endpoint: "https://web.push.apple.com/current",
      toJSON: () => ({ endpoint: "https://web.push.apple.com/current", keys: { p256dh: "p", auth: "a" } }),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal("PushManager", class PushManager {});
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });

    const result = await sendPushTestToCurrentDevice(
      {
        subscribePush: vi.fn().mockResolvedValue(undefined),
        sendPushTest: vi.fn().mockResolvedValue({ ok: true, attempted: 1, delivered: 1 }),
      },
      { testId: "test-timeout", confirmationTimeoutMs: 0 },
    );

    expect(result).toMatchObject({ ok: true, display: "unconfirmed" });
  });
});

describe("current push state", () => {
  it("surfaces denied web permission instead of calling an existing endpoint subscribed", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn() } }) },
    });
    vi.stubGlobal("PushManager", class PushManager {});
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });

    await expect(currentPushState()).resolves.toBe("denied");
  });
});

describe("iOS push context", () => {
  it("requires the app to run from the Home Screen", () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (iPhone)", maxTouchPoints: 5 });
    vi.stubGlobal("matchMedia", vi.fn());
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    expect(isIosNonStandalone()).toBe(true);
  });
});
