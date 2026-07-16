import { describe, expect, test } from "vitest";
import { parseArgs, helpText, versionText } from "../src/args.js";

describe("parseArgs", () => {
  test("defaults", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      version: false,
      noToken: false,
      confirm: false,
      activate: false,
      takeover: false,
      renew: false,
      release: false,
      revoke: false,
      appendNewline: false,
      command: "serve",
    });
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
      confirm: false,
      activate: false,
      takeover: false,
      renew: false,
      release: false,
      revoke: false,
      appendNewline: false,
      command: "serve",
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
  test("defaults to the serve command", () => {
    expect(parseArgs([]).command).toBe("serve");
  });
  test("install subcommand", () => {
    expect(parseArgs(["install"]).command).toBe("install");
  });
  test("uninstall subcommand", () => {
    expect(parseArgs(["uninstall"]).command).toBe("uninstall");
  });
  test("status subcommand", () => {
    expect(parseArgs(["status"]).command).toBe("status");
  });
  test("pair subcommand + public URL", () => {
    expect(parseArgs(["pair", "--url", "https://code.example"])).toMatchObject({
      command: "pair",
      publicUrl: "https://code.example",
    });
  });
  test("reset-access requires an explicit confirmation flag at dispatch", () => {
    expect(parseArgs(["reset-access", "--confirm"])).toMatchObject({ command: "reset-access", confirm: true });
  });
  test("api parses an action and bounded operation flags", () => {
    expect(
      parseArgs([
        "api",
        "wait",
        "--agent",
        "agent_1",
        "--after=10",
        "--timeout-ms",
        "30000",
        "--idempotency-key",
        "retry-1",
      ]),
    ).toMatchObject({
      command: "api",
      apiAction: "wait",
      agentId: "agent_1",
      after: "10",
      timeoutMs: "30000",
      idempotencyKey: "retry-1",
    });
  });
  test("api parses input lease identity and explicit lifecycle flags", () => {
    expect(
      parseArgs(["api", "lease", "--session", "session_1", "--client", "agent_1", "--lease", "lease-1", "--renew"]),
    ).toMatchObject({
      command: "api",
      apiAction: "lease",
      sessionId: "session_1",
      clientId: "agent_1",
      leaseId: "lease-1",
      renew: true,
    });
  });
  test("api parses peer federation scope without accepting a credential value", () => {
    expect(
      parseArgs([
        "api",
        "peer-add",
        "--peer-pairing-file",
        "/test/peer-pairing",
        "--actions",
        "read,wait,start",
        "--workspaces",
        "workspace-1,workspace-2",
        "--confirm",
      ]),
    ).toMatchObject({
      command: "api",
      apiAction: "peer-add",
      peerPairingFile: "/test/peer-pairing",
      actions: "read,wait,start",
      workspaces: "workspace-1,workspace-2",
      confirm: true,
    });
    expect(parseArgs(["api", "send", "--peer", "peer-1", "--newline"])).toMatchObject({
      peerId: "peer-1",
      appendNewline: true,
    });
  });
  test("cloud parses lifecycle actions without accepting a raw credential positional", () => {
    expect(
      parseArgs([
        "cloud",
        "connect",
        "--url",
        "https://relay.example",
        "--app-url",
        "https://app.example",
        "--label",
        "Workstation",
        "--account-token-file",
        "/test/account-token",
      ]),
    ).toMatchObject({
      command: "cloud",
      cloudAction: "connect",
      publicUrl: "https://relay.example",
      appUrl: "https://app.example",
      label: "Workstation",
      accountTokenFile: "/test/account-token",
    });
    expect(() => parseArgs(["cloud", "connect", `rrk_${"x".repeat(43)}`])).toThrow(/account-token-file/);
  });
  test("cloud parses secure hosted-account operator options", () => {
    expect(
      parseArgs([
        "cloud",
        "account-create",
        "--root-token-file",
        "/test/root-token",
        "--output",
        "/test/account-token",
        "--label",
        "Acme",
        "--plan",
        "team",
        "--max-routes",
        "25",
        "--max-devices-per-route",
        "64",
      ]),
    ).toMatchObject({
      command: "cloud",
      cloudAction: "account-create",
      rootTokenFile: "/test/root-token",
      output: "/test/account-token",
      label: "Acme",
      plan: "team",
      maxRoutes: "25",
      maxDevicesPerRoute: "64",
    });
  });
  test("a subcommand is only recognized as the leading positional", () => {
    // `install` after a flag is a non-leading positional → ignored, stays in serve mode.
    expect(parseArgs(["--no-token", "install"]).command).toBe("serve");
  });
});

describe("helpText", () => {
  test("mentions the command, the flags, and the secure-tunnel hint", () => {
    const h = helpText();
    expect(h).toContain("roamcode");
    expect(h).toContain("--port");
    expect(h).toContain("--bind");
    expect(h).toContain("--no-token");
    expect(h).toContain("--version");
    expect(h).toContain("--peer-pairing-file");
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
  test("mentions the install / uninstall subcommands", () => {
    const h = helpText();
    expect(h).toContain("install");
    expect(h).toContain("uninstall");
    expect(h).toContain("pair");
    expect(h).toContain("--url");
    expect(h).toContain("reset-access");
    expect(h).toContain("--confirm");
    expect(h).toContain("api <resource|action>");
    expect(h).toContain("ROAMCODE_API_TOKEN");
    expect(h).toContain("cloud <connect|configure|pair|status|rotate|disconnect>");
    expect(h).toContain("account-create|account-list|account-update|account-rotate|account-recover|account-delete");
    expect(h).toContain("--account-token-file");
    expect(h).toContain("--root-token-file");
    expect(h).toContain("ROAMCODE_CLOUD_ROOT_TOKEN_FILE");
    expect(h).toContain("--peer-credential-file");
    expect(h).toContain("ROAMCODE_PEER_CREDENTIAL_FILE");
    expect(h).toContain("ROAMCODE_CLOUD_URL");
  });

  test("describes both supported providers and their executable overrides", () => {
    const h = helpText();
    expect(h).toContain("Claude Code or Codex");
    expect(h).toContain("CLAUDE_BIN");
    expect(h).toContain("CODEX_BIN");
    expect(h).not.toMatch(/operate Claude Code sessions on this machine/i);
  });
});

describe("versionText", () => {
  test("is a non-empty version string", () => {
    expect(versionText()).toMatch(/\d+\.\d+\.\d+/);
  });
});
