import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("dual-provider release copy", () => {
  test("describes the standalone execution boundary without claiming provider isolation", () => {
    const site = read("site/index.html");
    expect(site).not.toMatch(/only party in the loop is you/i);
    expect(site).toMatch(
      /execution,\s+terminal state,\s+repositories,\s+and provider credentials stay on\s+your Node/i,
    );
    expect(site).toMatch(/no hosted dependency/i);
    expect(site).not.toMatch(/blind relay|create account|sign in/i);
    expect(site).toMatch(/provider\s+CLIs[\s\S]*normal provider services/i);
  });

  test("keeps the social preview at GitHub's high-resolution landscape size", () => {
    const social = readFileSync(resolve(root, "docs/social-preview.png"));
    expect(social.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(social.readUInt32BE(16)).toBe(1280);
    expect(social.readUInt32BE(20)).toBe(640);
  });

  test("keeps public copy typo-free", () => {
    const wsl = read("docs/windows-wsl.md");
    expect(wsl).not.toMatch(/\bthe\s+the\b/i);
  });
});
