import { expect, test } from "vitest";
import { AuthGate, extractBearerToken } from "../src/index.js";

test("extractBearerToken parses the Bearer scheme case-insensitively", () => {
  expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  expect(extractBearerToken("bearer abc123")).toBe("abc123");
  expect(extractBearerToken("Token abc123")).toBeUndefined();
  expect(extractBearerToken(undefined)).toBeUndefined();
  expect(extractBearerToken("Bearer")).toBeUndefined();
});

test("check() accepts the right token and rejects the wrong one", () => {
  const gate = new AuthGate({ token: "s3cret" });
  expect(gate.check("s3cret", "ip-a")).toEqual({ ok: true });
  expect(gate.check("nope", "ip-a")).toEqual({ ok: false, reason: "invalid" });
});

test("check() rejects a missing presented token as invalid", () => {
  const gate = new AuthGate({ token: "s3cret" });
  expect(gate.check(undefined, "ip-a")).toEqual({ ok: false, reason: "invalid" });
});

test("rejects an equal-length but wrong token (constant-time compare branch)", () => {
  // A wrong token of the SAME LENGTH skips the length-mismatch early return and exercises the
  // timingSafeEqual equal-length path, proving it returns false on a byte difference (not just on
  // a length difference).
  const token = "abcd1234abcd1234"; // 16 chars
  const gate = new AuthGate({ token });
  const wrong = "abcd1234abcd9999"; // same length, trailing chars differ
  expect(wrong.length).toBe(token.length);
  expect(gate.check(wrong, "client-1").ok).toBe(false);
  expect(gate.check(token, "client-2").ok).toBe(true);
});

test("a gate with no configured token never accepts", () => {
  const gate = new AuthGate({});
  expect(gate.check("anything", "ip-a")).toEqual({ ok: false, reason: "missing-token-config" });
});

test("independently revocable credentials authenticate without replacing the host token", () => {
  const active = new Set(["device-a"]);
  const gate = new AuthGate({ token: "host-key", verifyCredential: (token) => active.has(token) });
  expect(gate.check("host-key", "ip-a")).toEqual({ ok: true });
  expect(gate.check("device-a", "ip-b")).toEqual({ ok: true });
  active.delete("device-a");
  expect(gate.check("device-a", "ip-b")).toEqual({ ok: false, reason: "invalid" });
});

test("repeated wrong guesses lock the client out (but a correct token is always accepted)", () => {
  let t = 1000;
  const gate = new AuthGate({ token: "s3cret", maxFailures: 3, lockoutMs: 5000, now: () => t });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" }); // 3rd failure trips the lock
  // A WRONG token is now throttled as "locked"…
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "locked" });
  // …but the CORRECT token is ALWAYS accepted, even while locked — the DoS fix so a flood of bad guesses
  // (or, behind a proxy, ANY client's bad traffic on the shared key) can never lock out the real user. A
  // success also resets the client's state.
  expect(gate.check("s3cret", "ip-x")).toEqual({ ok: true });
  // Past the lockout window a fresh wrong guess is "invalid" again, not "locked".
  t += 5001;
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
});

test("expired lockout entries are evicted opportunistically (map does not grow unbounded)", () => {
  let t = 0;
  const gate = new AuthGate({ token: "secret", maxFailures: 1, lockoutMs: 100, now: () => t });
  // Lock out client A at t=0.
  gate.check("wrong", "A"); // 1 failure -> locks
  expect(gate.lockedClientCount()).toBe(1);
  // Advance past the lockout window; a check for a DIFFERENT client sweeps A out.
  t = 1000;
  gate.check("secret", "B"); // success for B; the sweep removes the expired A entry
  expect(gate.lockedClientCount()).toBe(0);
});

test("rotateToken swaps the secret: the new token works immediately", () => {
  const gate = new AuthGate({ token: "old-secret" });
  expect(gate.check("old-secret", "ip-a")).toEqual({ ok: true });
  gate.rotateToken("new-secret");
  // The NEW token works immediately.
  expect(gate.check("new-secret", "ip-a")).toEqual({ ok: true });
});

test("rotateToken grace window: the OLD token works within graceMs, then is rejected after it expires", () => {
  let t = 1000;
  const gate = new AuthGate({ token: "old-secret", graceMs: 60_000, now: () => t });
  gate.rotateToken("new-secret");
  // Within the grace window, an in-flight callback holding the OLD token still succeeds.
  expect(gate.check("old-secret", "ip-a")).toEqual({ ok: true });
  t += 59_000; // still inside the 60s window
  expect(gate.check("old-secret", "ip-a")).toEqual({ ok: true });
  // The NEW token works the whole time.
  expect(gate.check("new-secret", "ip-a")).toEqual({ ok: true });
  // Past the grace window the OLD token is dead.
  t += 2_000; // now 61s after rotation
  expect(gate.check("old-secret", "ip-a")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("new-secret", "ip-a")).toEqual({ ok: true });
});

test("rotateToken grace defaults to 60s when not configured", () => {
  let t = 0;
  const gate = new AuthGate({ token: "t0", now: () => t });
  gate.rotateToken("t1");
  t += 59_000;
  expect(gate.check("t0", "ip-a")).toEqual({ ok: true }); // old token still alive at 59s (default 60s grace)
  t += 2_000;
  expect(gate.check("t0", "ip-a")).toEqual({ ok: false, reason: "invalid" }); // dead at 61s
});

test("a 2nd rotation within the window SUPERSEDES previousToken with the most-recent old token (no list)", () => {
  let t = 0;
  const gate = new AuthGate({ token: "t0", graceMs: 60_000, now: () => t });
  gate.rotateToken("t1"); // previous = t0 (until t=60s)
  t += 10_000;
  gate.rotateToken("t2"); // previous = t1 (until t=70s); t0 is dropped, NOT retained alongside t1
  // The current token works.
  expect(gate.check("t2", "ip-a")).toEqual({ ok: true });
  // The most-recent old token (t1) is honored within ITS grace.
  expect(gate.check("t1", "ip-a")).toEqual({ ok: true });
  // The token from TWO rotations ago (t0) is NOT accepted — only one previous token is retained.
  expect(gate.check("t0", "ip-a")).toEqual({ ok: false, reason: "invalid" });
});

test("a wrong token of the OLD token's length is still rejected (length-mismatch hygiene on the grace compare)", () => {
  const t = 0;
  const gate = new AuthGate({ token: "current-token!!", graceMs: 60_000, now: () => t });
  gate.rotateToken("brand-new-token"); // previous = "current-token!!"
  // A same-length-as-previous but wrong token must NOT slip through the grace compare.
  const wrongSameLen = "currXnt-tokenXX";
  expect(wrongSameLen.length).toBe("current-token!!".length);
  expect(gate.check(wrongSameLen, "ip-a")).toEqual({ ok: false, reason: "invalid" });
});

test("rotateToken clears lockout state (an administrative reset)", () => {
  const t = 0;
  const gate = new AuthGate({ token: "old", maxFailures: 1, lockoutMs: 10_000, now: () => t });
  gate.check("wrong", "ip-x"); // trips the lock
  expect(gate.check("wrong", "ip-x")).toEqual({ ok: false, reason: "locked" }); // a WRONG guess is throttled
  gate.rotateToken("new");
  // Rotation cleared the lockout, so even a wrong guess is "invalid" (fresh slate) and the new token works.
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("new", "ip-x")).toEqual({ ok: true });
});

test("lockout is per-client; a success resets the failure count", () => {
  const t = 0; // never reassigned in this case (prefer-const); the other case advances the clock
  const gate = new AuthGate({ token: "s3cret", maxFailures: 2, lockoutMs: 1000, now: () => t });
  expect(gate.check("bad", "ip-1")).toEqual({ ok: false, reason: "invalid" });
  // A different client is unaffected.
  expect(gate.check("s3cret", "ip-2")).toEqual({ ok: true });
  // A success on ip-1 before it trips clears its count.
  expect(gate.check("s3cret", "ip-1")).toEqual({ ok: true });
  expect(gate.check("bad", "ip-1")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("s3cret", "ip-1")).toEqual({ ok: true }); // still not locked (count was reset)
});
