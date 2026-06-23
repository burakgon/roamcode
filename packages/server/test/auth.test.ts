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

test("repeated failures lock the client out, and the lock expires", () => {
  let t = 1000;
  const gate = new AuthGate({ token: "s3cret", maxFailures: 3, lockoutMs: 5000, now: () => t });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" });
  expect(gate.check("bad", "ip-x")).toEqual({ ok: false, reason: "invalid" }); // 3rd failure trips the lock
  // Now locked: even the CORRECT token is refused while locked.
  expect(gate.check("s3cret", "ip-x")).toEqual({ ok: false, reason: "locked" });
  // Advance past the lockout window -> allowed again.
  t += 5001;
  expect(gate.check("s3cret", "ip-x")).toEqual({ ok: true });
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
