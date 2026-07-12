import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(here, "../../../scripts/install.sh"), "utf8");

describe("one-command installer provider preflight", () => {
  test("checks Claude Code and Codex independently without making either fatal", () => {
    expect(script).toContain("command -v claude");
    expect(script).toContain("command -v codex");
    expect(script).toMatch(/Found claude/);
    expect(script).toMatch(/Found codex/);
    expect(script).not.toMatch(/command -v (?:claude|codex)[^\n]*\|\| die/);
  });

  test("explains that either supported provider is sufficient", () => {
    expect(script).toMatch(/at least one supported coding agent/i);
    expect(script).toMatch(/Claude Code or Codex/i);
  });
});
