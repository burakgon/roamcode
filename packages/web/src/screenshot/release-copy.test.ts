import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("dual-provider release copy", () => {
  test("limits self-hosting claims to RoamCode's control plane", () => {
    const site = read("site/index.html");
    const social = read("docs/social-preview.svg");
    expect(site).not.toMatch(/only party in the loop is you/i);
    expect(site).toMatch(/control plane.*your own machine/i);
    expect(site).toMatch(/provider CLIs.*normal service/i);
    expect(social).not.toMatch(/your code stays put/i);
    expect(social).toMatch(/control plane/i);
    expect(social).toMatch(/provider CLIs.*normal service/i);
  });

  test("keeps public copy complete and typo-free", () => {
    const social = read("docs/social-preview.svg");
    const wsl = read("docs/windows-wsl.md");
    expect(social).not.toMatch(/drives the actual\s*<\/text>/i);
    expect(wsl).not.toMatch(/\bthe\s+the\b/i);
  });
});
