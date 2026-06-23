import { describe, expect, test } from "vitest";
import { parseArgs, helpText, versionText } from "../src/args.js";

describe("parseArgs", () => {
  test("defaults", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false, noToken: false });
  });
  test("--help / -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });
  test("--port and --bind take values", () => {
    expect(parseArgs(["--port", "8080", "--bind", "0.0.0.0"])).toEqual({
      help: false,
      version: false,
      noToken: false,
      port: "8080",
      bind: "0.0.0.0",
    });
  });
  test("--port=VALUE form", () => {
    expect(parseArgs(["--port=8080"]).port).toBe("8080");
  });
  test("--no-token", () => {
    expect(parseArgs(["--no-token"]).noToken).toBe(true);
  });
  test("--version / -v", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });
  test("an unknown flag throws a clear error", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option.*--bogus/i);
  });
});

describe("helpText", () => {
  test("mentions the command, the flags, and the secure-tunnel hint", () => {
    const h = helpText();
    expect(h).toContain("remote-coder");
    expect(h).toContain("--port");
    expect(h).toContain("--bind");
    expect(h).toContain("--no-token");
    expect(h).toContain("--version");
    expect(h.toLowerCase()).toContain("token");
  });
  test("documents the env vars startServer reads", () => {
    const h = helpText();
    expect(h).toContain("PORT");
    expect(h).toContain("BIND_ADDRESS");
    expect(h).toContain("ACCESS_TOKEN");
    expect(h).toContain("FS_ROOT");
  });
  test("points at the secure remote-access / tunnel note", () => {
    expect(helpText().toLowerCase()).toContain("tunnel");
  });
});

describe("versionText", () => {
  test("is a non-empty version string", () => {
    expect(versionText()).toMatch(/\d+\.\d+\.\d+/);
  });
});
