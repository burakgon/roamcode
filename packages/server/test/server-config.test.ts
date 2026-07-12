import { expect, test } from "vitest";
import { loadServerConfig, isLoopbackAddress, assertConfigAllowsStart } from "../src/index.js";

test("loadServerConfig applies safe defaults (loopback, port 4280, no token)", () => {
  const cfg = loadServerConfig({ HOME: "/home/u" });
  expect(cfg.port).toBe(4280);
  expect(cfg.bindAddress).toBe("127.0.0.1");
  expect(cfg.accessToken).toBeUndefined();
  expect(cfg.fsRoot).toBe("/home/u");
  expect(cfg.maxUploadBytes).toBe(26214400);
  expect(cfg.claude.claudeBin).toBe("claude");
  expect(cfg.codexBin).toBe("codex");
});

test("loadServerConfig reads CODEX_BIN independently from CLAUDE_BIN", () => {
  const cfg = loadServerConfig({ CLAUDE_BIN: "/tools/claude", CODEX_BIN: "/tools/codex" });
  expect(cfg.claude.claudeBin).toBe("/tools/claude");
  expect(cfg.codexBin).toBe("/tools/codex");
});

test("loadServerConfig reads PORT, BIND_ADDRESS, ACCESS_TOKEN, FS_ROOT, MAX_UPLOAD_BYTES", () => {
  const cfg = loadServerConfig({
    PORT: "8080",
    BIND_ADDRESS: "0.0.0.0",
    ACCESS_TOKEN: "secret-token",
    FS_ROOT: "/srv/projects",
    MAX_UPLOAD_BYTES: "1048576",
  });
  expect(cfg.port).toBe(8080);
  expect(cfg.bindAddress).toBe("0.0.0.0");
  expect(cfg.accessToken).toBe("secret-token");
  expect(cfg.fsRoot).toBe("/srv/projects");
  expect(cfg.maxUploadBytes).toBe(1048576);
});

test("loadServerConfig defaults trustProxy off and reads TRUST_PROXY", () => {
  expect(loadServerConfig({}).trustProxy).toBeFalsy();
  expect(loadServerConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
  expect(loadServerConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
  expect(loadServerConfig({ TRUST_PROXY: "no" }).trustProxy).toBeFalsy();
  // An IP/CIDR-looking value is passed through as Fastify's trustProxy spec (trust ONLY that proxy hop).
  expect(loadServerConfig({ TRUST_PROXY: "127.0.0.1" }).trustProxy).toBe("127.0.0.1");
  expect(loadServerConfig({ TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
});

test("loadServerConfig applies safe defaults for the new limit/security controls", () => {
  const cfg = loadServerConfig({ HOME: "/home/u" });
  expect(cfg.rateLimitRpm).toBe(600);
  expect(cfg.rateLimitBurst).toBe(120);
  expect(cfg.maxSessions).toBe(25);
  expect(cfg.allowedOrigins).toEqual([]);
  expect(cfg.publicUrl).toBeUndefined();
});

test("loadServerConfig reads the new limit/security env vars", () => {
  const cfg = loadServerConfig({
    ROAMCODE_RATE_LIMIT_RPM: "300",
    ROAMCODE_RATE_LIMIT_BURST: "60",
    ROAMCODE_MAX_SESSIONS: "10",
    ROAMCODE_ALLOWED_ORIGINS: "https://a.example, https://b.example",
    ROAMCODE_PUBLIC_URL: "https://remote.example",
  });
  expect(cfg.rateLimitRpm).toBe(300);
  expect(cfg.rateLimitBurst).toBe(60);
  expect(cfg.maxSessions).toBe(10);
  expect(cfg.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
  expect(cfg.publicUrl).toBe("https://remote.example");
});

// Rename compat: pre-rename services still export REMOTE_CODER_* — those must keep working after an
// OTA update (their launchd plist / systemd unit is not rewritten by the updater).
test("legacy REMOTE_CODER_* env vars are honored as fallbacks; ROAMCODE_* wins when both are set", () => {
  const cfg = loadServerConfig({
    REMOTE_CODER_RATE_LIMIT_RPM: "120",
    REMOTE_CODER_MAX_SESSIONS: "5",
    REMOTE_CODER_ALLOWED_ORIGINS: "https://legacy.example",
    REMOTE_CODER_PUBLIC_URL: "https://legacy-public.example",
  });
  expect(cfg.rateLimitRpm).toBe(120);
  expect(cfg.maxSessions).toBe(5);
  expect(cfg.allowedOrigins).toEqual(["https://legacy.example"]);
  expect(cfg.publicUrl).toBe("https://legacy-public.example");

  const both = loadServerConfig({ ROAMCODE_MAX_SESSIONS: "10", REMOTE_CODER_MAX_SESSIONS: "5" });
  expect(both.maxSessions).toBe(10);
});

test("ROAMCODE_RATE_LIMIT_RPM=0 disables the limiter; ROAMCODE_MAX_SESSIONS=0 disables the cap", () => {
  const cfg = loadServerConfig({ ROAMCODE_RATE_LIMIT_RPM: "0", ROAMCODE_MAX_SESSIONS: "0" });
  expect(cfg.rateLimitRpm).toBe(0);
  expect(cfg.maxSessions).toBe(0);
});

test("a non-positive rate-limit BURST throws (a 0-size bucket would block everything)", () => {
  expect(() => loadServerConfig({ ROAMCODE_RATE_LIMIT_BURST: "0" } as NodeJS.ProcessEnv)).toThrow(
    /ROAMCODE_RATE_LIMIT_BURST/,
  );
});

test("loadServerConfig never surfaces ANTHROPIC_API_KEY", () => {
  const cfg = loadServerConfig({ ANTHROPIC_API_KEY: "sk-should-be-ignored" });
  expect(JSON.stringify(cfg)).not.toContain("sk-should-be-ignored");
});

test("a non-numeric PORT falls back to the default (no NaN)", () => {
  const cfg = loadServerConfig({ PORT: "not-a-number" } as NodeJS.ProcessEnv);
  expect(cfg.port).toBe(4280);
});

test("an out-of-range PORT throws a clear error", () => {
  expect(() => loadServerConfig({ PORT: "70000" } as NodeJS.ProcessEnv)).toThrow(/PORT/);
});

test("a non-numeric MAX_UPLOAD_BYTES falls back to the default", () => {
  const cfg = loadServerConfig({ MAX_UPLOAD_BYTES: "huge" } as NodeJS.ProcessEnv);
  expect(cfg.maxUploadBytes).toBe(26214400);
});

test("a non-positive MAX_UPLOAD_BYTES throws", () => {
  expect(() => loadServerConfig({ MAX_UPLOAD_BYTES: "0" } as NodeJS.ProcessEnv)).toThrow(/MAX_UPLOAD_BYTES/);
});

test("isLoopbackAddress recognises loopback forms", () => {
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("localhost")).toBe(true);
  expect(isLoopbackAddress("127.5.6.7")).toBe(true);
  expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  expect(isLoopbackAddress("192.168.1.10")).toBe(false);
});

test("assertConfigAllowsStart refuses a non-loopback bind without a token", () => {
  const cfg = loadServerConfig({ BIND_ADDRESS: "0.0.0.0" });
  expect(() => assertConfigAllowsStart(cfg)).toThrow(/refusing to start/);
});

test("assertConfigAllowsStart allows non-loopback WITH a token", () => {
  const cfg = loadServerConfig({ BIND_ADDRESS: "0.0.0.0", ACCESS_TOKEN: "t" });
  expect(() => assertConfigAllowsStart(cfg)).not.toThrow();
});

test("assertConfigAllowsStart allows loopback without a token", () => {
  const cfg = loadServerConfig({ BIND_ADDRESS: "127.0.0.1" });
  expect(() => assertConfigAllowsStart(cfg)).not.toThrow();
});
