// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

describe("single-VM gateway build contract", () => {
  test("builds the complete site without changing the terminal PWA contract", { timeout: 180_000 }, () => {
    const siteDirectory = process.cwd();
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: siteDirectory,
      env: { ...process.env },
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: "pipe",
    });

    const terminalDirectory = join(siteDirectory, "dist", "terminal");
    const terminalIndexPath = join(terminalDirectory, "index.html");
    const siteIndexPath = join(siteDirectory, "dist", "index.html");
    const manifestPath = join(terminalDirectory, "manifest.webmanifest");
    expect(existsSync(siteIndexPath)).toBe(true);
    expect(existsSync(join(siteDirectory, "dist", "token-scrub.js"))).toBe(true);
    expect(existsSync(terminalIndexPath)).toBe(true);
    expect(existsSync(join(terminalDirectory, "sw.js"))).toBe(true);

    const siteIndex = readFileSync(siteIndexPath, "utf8");
    expect(siteIndex).toContain('src="/token-scrub.js"');
    const inlineSiteScripts = siteIndex.match(/<script(?![^>]*\bsrc\s*=)[^>]*>/giu) ?? [];
    expect(inlineSiteScripts).toEqual(['<script type="application/ld+json">']);
    const structuredData = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(siteIndex)?.[1];
    expect(structuredData).toBeTruthy();
    const structuredDataHash = createHash("sha256")
      .update(structuredData ?? "")
      .digest("base64");
    expect(readFileSync(join(siteDirectory, "..", "packaging", "relay", "Caddyfile"), "utf8")).toContain(
      `'sha256-${structuredDataHash}'`,
    );

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
    expect(applicationJavaScript).toContain("/terminal");
    expect(applicationJavaScript).not.toContain("/packages/web/src/");

    const buildSource = readFileSync(join(siteDirectory, "scripts", "build.mjs"), "utf8");
    expect(buildSource).toContain('ROAMCODE_WEB_BASE: "/terminal/"');
    expect(buildSource).toContain('VITE_APP_PATH_PREFIX: "/terminal"');
    expect(buildSource.indexOf('"--dir", webDirectory, "exec", "vite", "build"')).toBeLessThan(
      buildSource.indexOf('"--dir", siteDirectory, "exec", "vite", "build"'),
    );
    expect(readFileSync(join(siteDirectory, "vite.config.ts"), "utf8")).toContain("emptyOutDir: false");
  });

  test("packages the full build behind one provider-neutral gateway", () => {
    const repositoryDirectory = resolve(process.cwd(), "..");
    const dockerfile = readFileSync(join(repositoryDirectory, "packaging", "relay", "Edge.Dockerfile"), "utf8");
    const caddyfile = readFileSync(join(repositoryDirectory, "packaging", "relay", "Caddyfile"), "utf8");
    const compose = readFileSync(join(repositoryDirectory, "packaging", "relay", "compose.yaml"), "utf8");

    expect(dockerfile).toContain("RUN pnpm --dir site build");
    expect(dockerfile).toContain("COPY --from=build /src/site/dist /srv");
    expect(dockerfile).toContain("USER 10002:10002");
    expect(caddyfile).toContain("{$ROAMCODE_DOMAIN}");
    expect(caddyfile).toContain(":8080 {");
    expect(caddyfile).toContain("respond /healthz 200");
    expect(caddyfile).toContain("{$ROAMCODE_API_UPSTREAM:api:4400}");
    expect(caddyfile).toContain("{$ROAMCODE_RELAY_UPSTREAM:relay:4281}");
    expect(caddyfile).toContain("path /api/auth/* /api/v1/*");
    expect(caddyfile).toContain("path /terminal /terminal/*");
    expect(caddyfile).toContain("header_up -Forwarded");
    expect(caddyfile).not.toContain("header_up -X-Forwarded-For");
    expect(caddyfile).toContain("header_up X-Forwarded-For {remote_host}");
    expect(caddyfile).toContain("path /api /api/* /internal /internal/* /v1 /v1/*");
    expect(compose).toContain("ROAMCODE_DOMAIN:");
    expect(compose).not.toContain("ROAMCODE_APP_DOMAIN");
    expect(compose).not.toContain("ROAMCODE_RELAY_DOMAIN");
    expect(caddyfile).not.toMatch(/cloudflare|wrangler|gcp/iu);
  });
});
