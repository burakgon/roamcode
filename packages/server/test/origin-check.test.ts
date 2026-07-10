import { expect, test } from "vitest";
import { isOriginAllowed, normalizeOrigin, parseAllowedOrigins } from "../src/index.js";

test("normalizeOrigin reduces a URL to scheme://host[:port], lowercased; default port elided", () => {
  expect(normalizeOrigin("https://Example.com/path?q=1")).toBe("https://example.com");
  expect(normalizeOrigin("https://example.com:443")).toBe("https://example.com");
  expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  expect(normalizeOrigin(undefined)).toBeUndefined();
  expect(normalizeOrigin("")).toBeUndefined();
  expect(normalizeOrigin("null")).toBeUndefined(); // opaque/sandboxed origin
  expect(normalizeOrigin("not a url")).toBeUndefined();
});

test("an ABSENT Origin is allowed (native clients + same-origin navigations omit it)", () => {
  expect(isOriginAllowed(undefined, "remotecode.example.com")).toBe(true);
  expect(isOriginAllowed("", "remotecode.example.com")).toBe(true);
  // An opaque/sandboxed "null" Origin can't be a real cross-origin page driving us → treated as absent.
  expect(isOriginAllowed("null", "remotecode.example.com")).toBe(true);
});

test("a SAME-ORIGIN request is allowed (the PWA, served same-origin, always is)", () => {
  expect(isOriginAllowed("https://remotecode.example.com", "remotecode.example.com")).toBe(true);
  // host:port must match exactly.
  expect(isOriginAllowed("http://127.0.0.1:4280", "127.0.0.1:4280")).toBe(true);
});

test("a LOOPBACK origin is allowed (local dev)", () => {
  expect(isOriginAllowed("http://localhost:5173", "127.0.0.1:4280")).toBe(true);
  expect(isOriginAllowed("http://127.0.0.1:9999", "0.0.0.0:4280")).toBe(true);
  expect(isOriginAllowed("http://[::1]:3000", "example.com")).toBe(true);
});

test("the configured PUBLIC URL origin is allowed even when it differs from Host", () => {
  // Behind a tunnel the request Host may be the internal bind, but the PWA's Origin is the public URL.
  expect(
    isOriginAllowed("https://remotecode.bgn.capital", "127.0.0.1:4280", {
      publicUrl: "https://remotecode.bgn.capital",
    }),
  ).toBe(true);
});

test("a FOREIGN, non-allow-listed Origin is REJECTED (the CSWSH defense)", () => {
  expect(isOriginAllowed("https://evil.example", "remotecode.example.com")).toBe(false);
  // Even with the right token in a URL, a foreign browser page stamps its own Origin → rejected.
  expect(
    isOriginAllowed("https://evil.example", "127.0.0.1:4280", { publicUrl: "https://remotecode.bgn.capital" }),
  ).toBe(false);
});

test("ROAMCODE_ALLOWED_ORIGINS extends the allow-list", () => {
  expect(
    isOriginAllowed("https://my-frontend.example", "remotecode.example.com", {
      allowedOrigins: ["https://my-frontend.example", "https://other.example"],
    }),
  ).toBe(true);
  // Still rejects an origin NOT in the list.
  expect(
    isOriginAllowed("https://nope.example", "remotecode.example.com", {
      allowedOrigins: ["https://my-frontend.example"],
    }),
  ).toBe(false);
});

test("parseAllowedOrigins splits + trims + drops empties", () => {
  expect(parseAllowedOrigins(undefined)).toEqual([]);
  expect(parseAllowedOrigins("")).toEqual([]);
  expect(parseAllowedOrigins(" https://a.example , https://b.example ,, ")).toEqual([
    "https://a.example",
    "https://b.example",
  ]);
});
