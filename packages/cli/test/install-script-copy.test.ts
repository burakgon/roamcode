import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(here, "../../../scripts/install.sh"), "utf8");

describe("one-command installer bootstrap", () => {
  test("checks only the bootstrap prerequisites", () => {
    expect(script).toContain("command -v node");
    expect(script).toContain("NODE_MAJOR");
    expect(script).toContain("command -v npx");
    expect(script).toContain("command -v tmux");
    expect(script).toMatch(/tmux is required for sessions/i);
  });

  test("delegates the durable install to the latest published CLI", () => {
    expect(script).toContain("exec npx --yes --allow-scripts=better-sqlite3,node-pty roamcode@latest install");
  });
});
