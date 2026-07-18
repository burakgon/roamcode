// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { unstable_dev } from "wrangler";

describe("hosted terminal build contract", () => {
  test("fails closed before a held Cloudflare production build can deploy", () => {
    const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "main",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toContain("Production Workers Build is held");
  });

  test("builds the real PWA under /terminal before preserving it through the site build", { timeout: 120_000 }, () => {
    const siteDirectory = process.cwd();
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: siteDirectory,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: "pipe",
    });

    const terminalDirectory = join(siteDirectory, "dist", "terminal");
    const terminalIndexPath = join(terminalDirectory, "index.html");
    const siteIndexPath = join(siteDirectory, "dist", "index.html");
    const manifestPath = join(terminalDirectory, "manifest.webmanifest");
    expect(existsSync(siteIndexPath)).toBe(true);
    expect(existsSync(terminalIndexPath)).toBe(true);
    expect(existsSync(join(terminalDirectory, "sw.js"))).toBe(true);

    const terminalIndex = readFileSync(terminalIndexPath, "utf8");
    expect(terminalIndex).toMatch(/(?:src|href)="\/terminal\/assets\//);
    expect(terminalIndex).toContain('href="/terminal/manifest.webmanifest"');
    expect(terminalIndex).toContain('href="/terminal/apple-touch-icon.png"');
    expect(terminalIndex).toContain('href="/terminal/icon-192.svg"');
    expect(terminalIndex).not.toMatch(/(?:src|href)="\/assets\//);
    expect(terminalIndex).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/iu);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scope?: string;
      start_url?: string;
    };
    expect(manifest).toMatchObject({ scope: "/terminal/", start_url: "/terminal/sessions" });

    const applicationJavaScript = readdirSync(join(terminalDirectory, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(terminalDirectory, "assets", name), "utf8"))
      .join("\n");
    expect(applicationJavaScript.includes("/terminal")).toBe(true);
    expect(applicationJavaScript.includes("/packages/web/src/")).toBe(false);

    const buildSource = readFileSync(join(siteDirectory, "scripts", "build.mjs"), "utf8");
    expect(buildSource).toContain('ROAMCODE_WEB_BASE: "/terminal/"');
    expect(buildSource).toContain('VITE_APP_PATH_PREFIX: "/terminal"');
    expect(buildSource.indexOf('"--dir", webDirectory, "exec", "vite", "build"')).toBeLessThan(
      buildSource.indexOf('"--dir", siteDirectory, "exec", "vite", "build"'),
    );
    expect(readFileSync(join(siteDirectory, "vite.config.ts"), "utf8")).toContain("emptyOutDir: false");

    const wranglerConfig = readFileSync(join(siteDirectory, "wrangler.jsonc"), "utf8");
    expect(wranglerConfig).toContain('"run_worker_first": true');
    const deployContract = readFileSync(join(siteDirectory, "DEPLOY.md"), "utf8");
    expect(existsSync(join(siteDirectory, ".production-deploy-hold"))).toBe(true);
    expect(buildSource).toContain('process.env.WORKERS_CI_BRANCH === "main"');
    for (const watchedPath of ["site/**", "packages/web/**", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      expect(deployContract).toContain(watchedPath);
    }
  });

  test(
    "preserves hosted enrollment navigation and shell headers in the real Workers asset runtime",
    { timeout: 30_000 },
    async () => {
      const worker = await unstable_dev("worker/index.ts", {
        config: "wrangler.jsonc",
        local: true,
        persist: false,
        logLevel: "none",
        experimental: {
          disableExperimentalWarning: true,
          disableDevRegistry: true,
          watch: false,
        },
      });
      try {
        for (const pathname of [
          "/terminal/",
          "/terminal/sessions?enroll=00000000-0000-4000-8000-000000000001",
          "/terminal/automations",
          "/terminal/agents",
        ]) {
          const response = await worker.fetch(pathname, { redirect: "manual" });
          expect(response.status).toBe(200);
          expect(response.headers.get("location")).toBeNull();
          expect(response.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
          expect(response.headers.get("referrer-policy")).toBe("no-referrer");
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          expect(response.headers.get("x-frame-options")).toBe("DENY");
          const csp = response.headers.get("content-security-policy") ?? "";
          const nonce = /script-src 'self' 'nonce-([^']+)'/u.exec(csp)?.[1];
          expect(csp).toContain("frame-ancestors 'none'");
          expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/u);
          expect(nonce).toBeTruthy();
          const html = await response.text();
          expect(html).toContain("/terminal/assets/");
          expect(html).toContain(`<script nonce="${nonce}">`);
          const inlineScripts = html.match(/<script(?![^>]*\bsrc\s*=)[^>]*>/giu) ?? [];
          expect(inlineScripts.length).toBeGreaterThan(0);
          expect(inlineScripts.every((tag) => tag.includes(`nonce="${nonce}"`))).toBe(true);
        }

        const conditionalShell = await worker.fetch("/terminal/sessions?enroll=00000000-0000-4000-8000-000000000001", {
          headers: { "if-none-match": '"old-shell"', range: "bytes=0-100" },
          redirect: "manual",
        });
        expect(conditionalShell.status).toBe(200);
        expect(conditionalShell.headers.get("etag")).toBeNull();
        expect(conditionalShell.headers.get("content-range")).toBeNull();

        const assetResponse = await worker.fetch("/terminal/manifest.webmanifest", { redirect: "manual" });
        expect(assetResponse.status).toBe(200);
        expect(assetResponse.headers.get("x-frame-options")).toBeNull();
        expect(assetResponse.headers.get("content-type")).toContain("application/manifest+json");
      } finally {
        await worker.stop();
      }
    },
  );
});
