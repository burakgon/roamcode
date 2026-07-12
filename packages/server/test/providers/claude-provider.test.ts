import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hookAuthPathFor, hooksSettingsPathFor, mcpConfigPathFor } from "../../src/config.js";
import { classifyPaneStatus } from "../../src/pane-status.js";
import { createClaudeProvider } from "../../src/providers/claude-provider.js";
import type { ProviderProcessContext } from "../../src/providers/types.js";

const fsFaults = vi.hoisted(() => ({
  write: undefined as undefined | ((path: string) => "partial" | undefined),
  chmod: undefined as undefined | ((path: string) => boolean),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const path = String(args[0]);
      const fault = fsFaults.write?.(path);
      if (fault === "partial") {
        Reflect.apply(actual.writeFileSync, actual, [path, "partial-token-material", args[2]]);
        throw new Error(`injected partial write failure: ${path}`);
      }
      return Reflect.apply(actual.writeFileSync, actual, args);
    },
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      const path = String(args[0]);
      if (fsFaults.chmod?.(path)) throw new Error(`injected chmod failure: ${path}`);
      return Reflect.apply(actual.chmodSync, actual, args);
    },
  };
});

afterEach(() => {
  fsFaults.write = undefined;
  fsFaults.chmod = undefined;
});

function processContext(
  intent: "fresh" | "resume",
  options: ProviderProcessContext["options"] = { provider: "claude" },
): ProviderProcessContext {
  return {
    roamSessionId: "claude-1",
    cwd: "/work",
    intent,
    options,
  };
}

describe("Claude provider", () => {
  test("fresh process preserves supported options, attachments, hooks, and subscription auth", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roamcode-claude-provider-"));
    const sourceEnv = { PATH: "/bin", ANTHROPIC_API_KEY: "must-not-reach-claude" };
    const attach = {
      baseUrl: "http://127.0.0.1:4280",
      token: "attachment-token",
      mcpScriptPath: "/app/mcp-send.js",
      dataDir,
    };
    const provider = createClaudeProvider({ claudeBin: "/opt/claude", env: sourceEnv, attach });

    try {
      const spec = await provider.buildProcess(
        processContext("fresh", {
          provider: "claude",
          model: "opus",
          effort: "max",
          permissionMode: "plan",
          addDirs: ["/extra", "/another"],
        }),
      );

      const mcpPath = mcpConfigPathFor(dataDir, "claude-1");
      const settingsPath = hooksSettingsPathFor(dataDir, "claude-1");
      const authPath = hookAuthPathFor(dataDir, "claude-1");
      expect(spec).toMatchObject({ executable: "/opt/claude" });
      expect(spec.args).toEqual([
        "--model",
        "opus",
        "--effort",
        "max",
        "--permission-mode",
        "plan",
        "--add-dir",
        "/extra",
        "--add-dir",
        "/another",
        "--mcp-config",
        mcpPath,
        "--settings",
        settingsPath,
      ]);
      expect(spec.cleanupPaths).toEqual([mcpPath, authPath, settingsPath]);
      expect(spec.env).toEqual({ PATH: "/bin" });
      expect(sourceEnv).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "must-not-reach-claude" });

      for (const path of spec.cleanupPaths) expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toMatchObject({
        mcpServers: { roamcode: { env: { RC_SESSION_ID: "claude-1", RC_TOKEN: "attachment-token" } } },
      });
      expect(readFileSync(authPath, "utf8")).toBe("Authorization: Bearer attachment-token\n");
      expect(readFileSync(settingsPath, "utf8")).toContain("/sessions/claude-1/hook?event=stop");
      expect(JSON.stringify(spec.args)).not.toContain("attachment-token");
      expect(JSON.stringify(spec.env)).not.toContain("attachment-token");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("dangerous skip suppresses the ordinary permission mode", async () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const spec = await provider.buildProcess(
      processContext("fresh", {
        provider: "claude",
        dangerouslySkip: true,
        permissionMode: "plan",
      }),
    );

    expect(spec.args).toEqual(["--dangerously-skip-permissions"]);
    expect(spec.args).not.toContain("--permission-mode");
  });

  test("resume owns continuation and emits exactly one continue flag", async () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const spec = await provider.buildProcess(
      processContext("resume", {
        provider: "claude",
        model: "sonnet",
        legacyArgs: ["--continue", "--verbose"],
      }),
    );

    expect(spec.args.filter((arg) => arg === "--continue")).toHaveLength(1);
    expect(spec.args).toEqual(["--model", "sonnet", "--verbose", "--continue"]);
  });

  test("fresh launch does not inherit a legacy continue flag", async () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const spec = await provider.buildProcess(
      processContext("fresh", { provider: "claude", legacyArgs: ["--continue", "--verbose"] }),
    );

    expect(spec.args).toEqual(["--verbose"]);
  });

  test("fresh launch strips every provider-owned legacy spelling without leaking its value", async () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const spec = await provider.buildProcess(
      processContext("fresh", {
        provider: "claude",
        model: "typed-model",
        effort: "max",
        permissionMode: "plan",
        addDirs: ["/typed-dir"],
        legacyArgs: [
          "--verbose",
          "unknown-positional",
          "--continue",
          "-c",
          "--resume",
          "legacy-session",
          "--resume=equal-session",
          "-r",
          "short-session",
          "-rattached-session",
          "-r=equal-short-session",
          "--session-id",
          "legacy-fixed-session",
          "--session-id=equal-fixed-session",
          "--model",
          "legacy-model",
          "--model=equal-model",
          "--effort",
          "low",
          "--effort=high",
          "--permission-mode",
          "bypassPermissions",
          "--permission-mode=acceptEdits",
          "--dangerously-skip-permissions",
          "--dangerously-skip-permissions=true",
          "--add-dir",
          "/legacy-dir",
          "/second-legacy-dir",
          "--add-dir=/equal-dir",
          "--mcp-config",
          "/tmp/legacy-mcp.json",
          "/tmp/second-legacy-mcp.json",
          "--mcp-config=/tmp/equal-mcp.json",
          "--settings",
          "/tmp/legacy-settings.json",
          "--settings=/tmp/equal-settings.json",
          "--debug",
          "api",
        ],
      }),
    );

    expect(spec.args).toEqual([
      "--model",
      "typed-model",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
      "--add-dir",
      "/typed-dir",
      "--verbose",
      "unknown-positional",
      "--debug",
      "api",
    ]);
  });

  test("resume strips legacy safety and session selectors before adding exactly one owned continuation", async () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const spec = await provider.buildProcess(
      processContext("resume", {
        provider: "claude",
        dangerouslySkip: true,
        legacyArgs: [
          "before",
          "--permission-mode=plan",
          "--resume=legacy-session",
          "-rother-session",
          "--continue=true",
          "after",
        ],
      }),
    );

    expect(spec.args).toEqual(["--dangerously-skip-permissions", "before", "after", "--continue"]);
    expect(spec.args.filter((arg) => arg === "--continue")).toHaveLength(1);
  });

  test.each(["fresh", "resume"] as const)(
    "%s launch preserves the separator tail and keeps every owned flag before it",
    async (intent) => {
      const dataDir = mkdtempSync(join(tmpdir(), `roamcode-claude-separator-${intent}-`));
      const provider = createClaudeProvider({
        claudeBin: "claude",
        env: {},
        attach: {
          baseUrl: "http://127.0.0.1:4280",
          token: "separator-token",
          mcpScriptPath: "/app/mcp-send.js",
          dataDir,
        },
      });
      const opaqueTail = [
        "--",
        "--model",
        "literal-model",
        "--settings=",
        "--mcp-config",
        "--continue",
        "-cattached",
        "--permission-mode",
        "--",
        "--resume=",
      ];

      try {
        const spec = await provider.buildProcess(
          processContext(intent, {
            provider: "claude",
            model: "typed-model",
            effort: "high",
            permissionMode: "plan",
            addDirs: ["/typed-dir"],
            legacyArgs: [
              "--verbose",
              "--model=legacy-model",
              "--settings",
              "/tmp/legacy-settings.json",
              "--continue",
              ...opaqueTail,
            ],
          }),
        );
        const separatorIndex = spec.args.indexOf("--");
        const beforeSeparator = spec.args.slice(0, separatorIndex);

        expect(separatorIndex).toBeGreaterThan(-1);
        expect(spec.args.slice(separatorIndex)).toEqual(opaqueTail);
        expect(beforeSeparator).toEqual([
          "--model",
          "typed-model",
          "--effort",
          "high",
          "--permission-mode",
          "plan",
          "--add-dir",
          "/typed-dir",
          "--verbose",
          "--mcp-config",
          mcpConfigPathFor(dataDir, "claude-1"),
          "--settings",
          hooksSettingsPathFor(dataDir, "claude-1"),
          ...(intent === "resume" ? ["--continue"] : []),
        ]);
        expect(beforeSeparator.filter((arg) => arg === "--continue")).toHaveLength(intent === "resume" ? 1 : 0);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    [["--model"], "--model requires a value"],
    [["--effort="], "--effort requires a value"],
    [["--permission-mode", "--continue"], "--permission-mode requires a value"],
    [["--add-dir="], "--add-dir requires a value"],
    [["--mcp-config", "--settings=/tmp/settings.json"], "--mcp-config requires a value"],
    [["--settings="], "--settings requires a value"],
    [["--resume="], "--resume has an ambiguous empty value"],
    [["-r="], "-r has an ambiguous empty value"],
    [["-cattached"], "-c has an ambiguous attached value"],
  ])("fails closed for malformed provider-owned legacy arguments %#", async (legacyArgs, message) => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });

    await expect(
      provider.buildProcess(processContext("fresh", { provider: "claude", legacyArgs })),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OPTIONS", message: expect.stringContaining(message) });
  });

  test("rejects non-Claude options instead of inferring a provider", async () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });

    await expect(
      provider.buildProcess(processContext("fresh", { provider: "codex", model: "gpt-5.6" })),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_OPTIONS" });
  });

  test("registers each token-bearing cleanup path immediately", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roamcode-claude-cleanup-"));
    const provider = createClaudeProvider({
      claudeBin: "claude",
      env: {},
      attach: {
        baseUrl: "http://127.0.0.1:4280",
        token: "cleanup-token",
        mcpScriptPath: "/app/mcp-send.js",
        dataDir,
      },
    });
    const registered: string[] = [];

    try {
      await expect(
        provider.buildProcess({
          ...processContext("fresh"),
          registerCleanupPaths: (paths) => {
            registered.push(...paths);
            if (registered.length === 2) throw new Error("manager rejected build");
          },
        }),
      ).rejects.toThrow("manager rejected build");

      expect(registered).toEqual([mcpConfigPathFor(dataDir, "claude-1"), hookAuthPathFor(dataDir, "claude-1")]);
      expect(existsSync(hooksSettingsPathFor(dataDir, "claude-1"))).toBe(false);
      provider.cleanup(registered);
      for (const path of registered) expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test.each([1, 2, 3])(
    "registration failure at sequential artifact %i rolls back every file and propagates",
    async (failAt) => {
      const dataDir = mkdtempSync(join(tmpdir(), "roamcode-claude-register-fault-"));
      const paths = [
        mcpConfigPathFor(dataDir, "claude-1"),
        hookAuthPathFor(dataDir, "claude-1"),
        hooksSettingsPathFor(dataDir, "claude-1"),
      ];
      const provider = createClaudeProvider({
        claudeBin: "claude",
        env: {},
        attach: {
          baseUrl: "http://127.0.0.1:4280",
          token: "registration-fault-token",
          mcpScriptPath: "/app/mcp-send.js",
          dataDir,
        },
      });
      const registered: string[] = [];

      try {
        await expect(
          provider.buildProcess({
            ...processContext("fresh"),
            registerCleanupPaths: (newPaths) => {
              registered.push(...newPaths);
              if (registered.length === failAt) throw new Error(`registration failure ${failAt}`);
            },
          }),
        ).rejects.toThrow(`registration failure ${failAt}`);

        expect(registered).toEqual(paths.slice(0, failAt));
        for (const path of paths) expect(existsSync(path)).toBe(false);
        expect(() => provider.cleanup(registered)).not.toThrow();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );

  test.each(["partial-write", "chmod"] as const)(
    "%s failure unlinks MCP, hook auth, and settings artifacts locally",
    async (faultKind) => {
      for (const failedArtifact of ["mcp", "auth", "settings"] as const) {
        const dataDir = mkdtempSync(join(tmpdir(), `roamcode-claude-${faultKind}-${failedArtifact}-`));
        const paths = {
          mcp: mcpConfigPathFor(dataDir, "claude-1"),
          auth: hookAuthPathFor(dataDir, "claude-1"),
          settings: hooksSettingsPathFor(dataDir, "claude-1"),
        };
        const registered: string[] = [];
        const provider = createClaudeProvider({
          claudeBin: "claude",
          env: {},
          attach: {
            baseUrl: "http://127.0.0.1:4280",
            token: "filesystem-fault-token",
            mcpScriptPath: "/app/mcp-send.js",
            dataDir,
          },
        });

        if (faultKind === "partial-write") {
          fsFaults.write = (path) => (path === paths[failedArtifact] ? "partial" : undefined);
        } else {
          fsFaults.chmod = (path) => path === paths[failedArtifact];
        }

        try {
          const spec = await provider.buildProcess({
            ...processContext("fresh"),
            registerCleanupPaths: (newPaths) => registered.push(...newPaths),
          });

          expect(registered).toContain(paths[failedArtifact]);
          expect(existsSync(paths[failedArtifact])).toBe(false);
          if (failedArtifact === "auth" || failedArtifact === "settings") {
            expect(existsSync(paths.auth)).toBe(false);
            expect(spec.args).not.toContain("--settings");
          }
          expect(() => provider.cleanup(registered)).not.toThrow();
          for (const path of Object.values(paths)) expect(existsSync(path)).toBe(false);
        } finally {
          fsFaults.write = undefined;
          fsFaults.chmod = undefined;
          rmSync(dataDir, { recursive: true, force: true });
        }
      }
    },
  );

  test("delegates Claude pane classification and has no output protocol signals", () => {
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const panes = ["✢ Harmonizing… (1m 34s · ↓ 5.1k tokens)", "Do you want to proceed?", "❯\n─────"];

    for (const pane of panes) expect(provider.classifyPane(pane)).toBe(classifyPaneStatus(pane));
    expect(provider.runtimeSignals("arbitrary Claude TUI output")).toEqual([]);
  });

  test("cleanup is idempotent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "roamcode-claude-idempotent-"));
    const provider = createClaudeProvider({ claudeBin: "claude", env: {} });
    const missingPath = join(dataDir, "already-missing");

    expect(() => provider.cleanup([missingPath])).not.toThrow();
    expect(() => provider.cleanup([missingPath])).not.toThrow();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
