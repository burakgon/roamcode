import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { providerSessionDisplay } from "../session/provider-display";

const dir = dirname(fileURLToPath(import.meta.url));
const ansiPath = join(dir, "codex-mobile.ansi");
const claudeAnsiPath = join(dir, "claude-mobile-start.ansi");
const scenes = readFileSync(join(dir, "scenes.tsx"), "utf8");
const shots = readFileSync(join(dir, "../../scripts/shots.mjs"), "utf8");

describe("deterministic Codex marketing scene", () => {
  test("uses a dedicated sanitized Codex frame and provider-native session", () => {
    expect(existsSync(ansiPath)).toBe(true);
    if (!existsSync(ansiPath)) return;
    const ansi = readFileSync(ansiPath, "utf8");
    expect(ansi).toMatch(/OpenAI Codex/);
    expect(ansi).not.toMatch(/Claude Code|burakgon|rc_[a-z0-9]|Bearer|userCode|loginId/i);
    expect(scenes).toContain('import codexMobile from "./codex-mobile.ansi?raw"');
    expect(scenes).toContain('provider: "codex"');
    expect(scenes).toContain('model: "gpt-5.6-sol"');
    expect(scenes).toContain('effort: "xhigh"');
    expect(scenes).toContain('sandbox: "read-only"');
    expect(scenes).toContain('approvalPolicy: "on-request"');
    expect(scenes).toMatch(/codex:\s*\(\)/);
  });

  test("keeps captured provider frames free of maintainer identity", () => {
    const frames = [ansiPath, claudeAnsiPath].map((path) => readFileSync(path, "utf8"));
    for (const frame of frames) {
      expect(frame).not.toMatch(/burak(?:gon)?|rc_[a-z0-9]|Bearer|userCode|loginId/i);
    }
  });

  test("renders provider-native model, reasoning, sandbox, and approval labels", () => {
    expect(
      providerSessionDisplay({
        id: "synthetic-codex",
        provider: "codex",
        cwd: "/Users/you/dev/acme-api",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        sandbox: "read-only",
        approvalPolicy: "on-request",
        dangerouslySkip: false,
        status: "running",
        createdAt: 1,
      }),
    ).toEqual({
      provider: "Codex",
      model: "gpt-5.6-sol",
      effort: "xhigh reasoning",
      safety: ["read-only sandbox", "on-request approvals"],
      dangerous: false,
    });
  });

  test("registers a production-faithful codex-mobile shot without metadata layout overrides", () => {
    expect(shots).not.toContain("CODEX_HEADER_STYLE");
    expect(shots).not.toContain("rc-hdr-flags");
    expect(shots).toContain('{ name: "codex-mobile", scene: "codex", mobile: true, wait: 2200 }');
  });

  test("keeps showcase shells aligned with the real desktop and mobile navigation", () => {
    expect(scenes).toMatch(/desktop:\s*\(\)\s*=>[\s\S]*?navigation=\{productNavigation\("sessions"\)\}/);
    expect(scenes).toMatch(/split:\s*\(\)\s*=>[\s\S]*?navigation=\{productNavigation\("sessions"\)\}/);
    expect(scenes).toMatch(/agents:\s*\(\)\s*=>[\s\S]*?mobileNavigation=\{productNavigation\("agents", "bottom"\)\}/);
    expect(scenes).toMatch(
      /automations:\s*\(\)\s*=>[\s\S]*?mobileNavigation=\{productNavigation\("automations", "bottom"\)\}/,
    );
    expect(scenes).toContain("terminal: () => mobileSessionShell");
    expect(scenes).toContain("codex: () => mobileSessionShell");
    expect(scenes).toMatch(/files:\s*\(\)\s*=>\s*mobileSessionShell/);
    expect(scenes).not.toContain("showMobileNavigation");
    expect(scenes).toContain("onOpenHelp={() => {}}");
  });
});
