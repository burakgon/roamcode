// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("standalone marketing build contract", () => {
  test(
    "builds a static product site without embedding an account or terminal application",
    { timeout: 120_000 },
    () => {
      const siteDirectory = process.cwd();
      const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      execFileSync(pnpm, ["build"], {
        cwd: siteDirectory,
        env: { ...process.env },
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: "pipe",
      });

      const indexPath = join(siteDirectory, "dist", "index.html");
      expect(existsSync(indexPath)).toBe(true);
      expect(existsSync(join(siteDirectory, "dist", "terminal"))).toBe(false);
      expect(existsSync(join(siteDirectory, "dist", "token-scrub.js"))).toBe(false);

      const index = readFileSync(indexPath, "utf8");
      expect(index).toContain("Install RoamCode");
      expect(index).not.toContain('href="/app');
      expect(index).not.toContain("data-hosted-account-entry");
      expect(index).not.toContain("/terminal/");
      expect(index.match(/<script(?![^>]*\bsrc\s*=)[^>]*>/giu) ?? []).toEqual(['<script type="application/ld+json">']);
    },
  );
});
