import { expect, test } from "vitest";
import {
  loadServerConfig,
  isLoopbackAddress,
  assertConfigAllowsStart,
} from "../src/index.js";

test("loadServerConfig applies safe defaults (loopback, port 4280, no token)", () => {
  const cfg = loadServerConfig({ HOME: "/home/u" });
  expect(cfg.port).toBe(4280);
  expect(cfg.bindAddress).toBe("127.0.0.1");
  expect(cfg.accessToken).toBeUndefined();
  expect(cfg.fsRoot).toBe("/home/u");
  expect(cfg.maxUploadBytes).toBe(26214400);
  expect(cfg.claude.claudeBin).toBe("claude");
});

test("loadServerConfig reads PORT, BIND_ADDRESS, ACCESS_TOKEN, FS_ROOT, MAX_UPLOAD_BYTES", () => {
  const cfg = loadServerConfig({
    PORT: "8080",
    BIND_ADDRESS: "0.0.0.0",
    ACCESS_TOKEN: "secret-token",
    FS_ROOT: "/srv/projects",
    MAX_UPLOAD_BYTES: "1048576",
    CLAUDE_DEFAULT_MODEL: "opus",
  });
  expect(cfg.port).toBe(8080);
  expect(cfg.bindAddress).toBe("0.0.0.0");
  expect(cfg.accessToken).toBe("secret-token");
  expect(cfg.fsRoot).toBe("/srv/projects");
  expect(cfg.maxUploadBytes).toBe(1048576);
  expect(cfg.claude.defaultModel).toBe("opus");
});

test("loadServerConfig defaults trustProxy off and reads TRUST_PROXY", () => {
  expect(loadServerConfig({}).trustProxy).toBeFalsy();
  expect(loadServerConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
  expect(loadServerConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(true);
  expect(loadServerConfig({ TRUST_PROXY: "no" }).trustProxy).toBeFalsy();
});

test("loadServerConfig never surfaces ANTHROPIC_API_KEY", () => {
  const cfg = loadServerConfig({ ANTHROPIC_API_KEY: "sk-should-be-ignored" });
  expect(JSON.stringify(cfg)).not.toContain("sk-should-be-ignored");
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
