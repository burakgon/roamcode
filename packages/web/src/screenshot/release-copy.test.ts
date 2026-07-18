import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("dual-provider release copy", () => {
  test("describes the local execution and optional blind-relay boundary without claiming provider isolation", () => {
    const site = read("site/index.html");
    const social = read("docs/social-preview.svg");
    expect(site).not.toMatch(/only party in the loop is you/i);
    expect(site).toMatch(/execution, source code, provider credentials, and terminal state stay on your Nodes/i);
    expect(site).toMatch(/optional hosted blind relay/i);
    expect(site).toMatch(/provider\s+CLIs[\s\S]*normal provider services/i);
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
