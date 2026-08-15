import { beforeEach, expect, test, vi } from "vitest";

// Mock the `web-push` module. vi.hoisted so the mock fns exist when the (hoisted) vi.mock factory runs.
const { setVapidDetails, sendNotification } = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("web-push", () => ({ default: { setVapidDetails, sendNotification } }));

import { createWebPushSend } from "../src/web-push-send.js";

const VAPID = { publicKey: "pub-key", privateKey: "priv-key" };
const SUB = { endpoint: "https://push.example/abc", p256dh: "p256", auth: "auth" };

beforeEach(() => {
  setVapidDetails.mockReset();
  sendNotification.mockReset();
});

test("sets VAPID details once and returns the success status code", async () => {
  sendNotification.mockResolvedValue({ statusCode: 201 });
  const send = createWebPushSend({ vapid: VAPID, subject: "mailto:me@example.com" });
  expect(setVapidDetails).toHaveBeenCalledWith("mailto:me@example.com", "pub-key", "priv-key");
  await expect(send(SUB, '{"t":"x"}')).resolves.toEqual({ statusCode: 201 });
  // Maps our flat record → web-push's {endpoint, keys} shape.
  expect(sendNotification).toHaveBeenCalledWith(
    { endpoint: SUB.endpoint, keys: { p256dh: "p256", auth: "auth" } },
    '{"t":"x"}',
    { contentEncoding: "aes128gcm" },
  );
});

test("maps an HTTP error (410 Gone / 404) to its status code so the dispatcher can prune the dead sub", async () => {
  const send = createWebPushSend({ vapid: VAPID, subject: "mailto:me@example.com" });
  sendNotification.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
  await expect(send(SUB, "{}")).resolves.toEqual({ statusCode: 410 });
  sendNotification.mockRejectedValueOnce(Object.assign(new Error("not found"), { statusCode: 404 }));
  await expect(send(SUB, "{}")).resolves.toEqual({ statusCode: 404 });
});

test("rethrows a non-HTTP failure (no statusCode) so a good subscription is NOT mistaken for dead", async () => {
  sendNotification.mockRejectedValue(new Error("encryption failed"));
  const send = createWebPushSend({ vapid: VAPID, subject: "mailto:me@example.com" });
  await expect(send(SUB, "{}")).rejects.toThrow("encryption failed");
});

test("carries the push service's stated REASON, which is the only thing that distinguishes one 403 from another", async () => {
  // A 403 means the push service refused our VAPID credentials, and its body says WHY: a subject it will
  // not accept ("BadJwtToken") versus a subscription created against a different application server key
  // ("VapidPkHashMismatch"). Those need opposite fixes, and the status alone cannot tell them apart.
  const send = createWebPushSend({ vapid: VAPID, subject: "mailto:me@example.com" });
  sendNotification.mockRejectedValueOnce(
    Object.assign(new Error("Received unexpected response code"), {
      statusCode: 403,
      body: '{"reason":"BadJwtToken"}',
    }),
  );
  await expect(send(SUB, "{}")).resolves.toEqual({ statusCode: 403, reason: '{"reason":"BadJwtToken"}' });
});
