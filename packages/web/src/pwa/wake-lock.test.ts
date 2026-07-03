import { expect, test, vi } from "vitest";
import { installWakeLock } from "./wake-lock";

function fakeSentinel() {
  let releaseCb: (() => void) | undefined;
  return {
    released: false,
    release: vi.fn(async function (this: { released: boolean }) {
      this.released = true;
      releaseCb?.();
    }),
    addEventListener: (_: "release", cb: () => void) => {
      releaseCb = cb;
    },
    fireRelease: () => releaseCb?.(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("acquires a screen wake lock when visible, and is a NO-OP without the API (jsdom/old browsers)", async () => {
  // No API → never throws.
  const off = installWakeLock(document, {});
  off();

  const sentinel = fakeSentinel();
  const request = vi.fn(async () => sentinel);
  const dispose = installWakeLock(document, { wakeLock: { request } });
  await tick();
  expect(request).toHaveBeenCalledWith("screen");
  dispose();
  await tick();
  expect(sentinel.release).toHaveBeenCalled(); // disposer lets the screen sleep again
});

test("re-acquires on return to visibility after the OS releases it", async () => {
  const s1 = fakeSentinel();
  const s2 = fakeSentinel();
  const request = vi.fn().mockResolvedValueOnce(s1).mockResolvedValueOnce(s2);
  const dispose = installWakeLock(document, { wakeLock: { request } });
  await tick();
  expect(request).toHaveBeenCalledTimes(1);

  // Backgrounding: the OS auto-releases the lock…
  s1.fireRelease();
  // …and coming back to the foreground re-requests it.
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(request).toHaveBeenCalledTimes(2);

  // A visibilitychange while STILL holding a lock must not stack another request.
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(request).toHaveBeenCalledTimes(2);
  dispose();
});

test("a denial (low battery / policy) is silent and doesn't break later re-acquires", async () => {
  const s = fakeSentinel();
  const request = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(s);
  const dispose = installWakeLock(document, { wakeLock: { request } });
  await tick(); // denied — no throw
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(request).toHaveBeenCalledTimes(2); // tried again once visible again
  dispose();
});
