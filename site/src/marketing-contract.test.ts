import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

function linkByText(root: ParentNode, label: string): HTMLAnchorElement | undefined {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a")).find((link) => link.textContent?.trim() === label);
}

describe("marketing account entry points", () => {
  test("keeps sign-in native while account-creation links start fail-closed", () => {
    const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
    const primary = page.querySelector('header nav[aria-label="Primary"]');
    const heroActions = page.querySelector(".hero .ctas");
    expect(primary).not.toBeNull();
    expect(heroActions).not.toBeNull();

    for (const [index, root] of [primary!, heroActions!].entries()) {
      const signIn = linkByText(root, "Sign in");
      const createAccount = linkByText(root, index === 0 ? "Continue to RoamCode" : "Sign in or create account");
      expect(signIn?.getAttribute("href")).toBe("/app");
      expect(createAccount?.getAttribute("href")).toBe("/app?mode=sign-up");
      expect(signIn?.classList.contains("chip")).toBe(true);
      expect(createAccount?.classList.contains("chip")).toBe(true);
      expect(createAccount?.classList.contains("solid")).toBe(true);
      expect(createAccount?.hasAttribute("data-hosted-account-entry")).toBe(true);
      expect(createAccount?.hidden).toBe(true);
      expect(signIn?.hasAttribute("style")).toBe(false);
      expect(createAccount?.hasAttribute("style")).toBe(false);
      expect(signIn?.tabIndex).toBe(0);
      expect(createAccount?.tabIndex).toBe(0);
    }
  });

  test("keeps account, terminal, activation, and API surfaces out of search indexes", () => {
    const robots = readFileSync("public/robots.txt", "utf8");
    for (const path of ["/app", "/activate", "/invite", "/terminal", "/api/"]) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });

  test("publishes first-party legal, security, and contact routes from the marketing footer", () => {
    const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
    const footer = page.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(linkByText(footer!, "Terms")?.getAttribute("href")).toBe("/legal/terms");
    expect(linkByText(footer!, "Privacy")?.getAttribute("href")).toBe("/legal/privacy");
    expect(linkByText(footer!, "Security")?.getAttribute("href")).toBe("/security");
    expect(linkByText(footer!, "Contact")?.getAttribute("href")).toBe("/contact");

    const sitemap = readFileSync("public/sitemap.xml", "utf8");
    for (const path of [
      "/legal/terms",
      "/legal/privacy",
      "/legal/acceptable-use",
      "/legal/dpa",
      "/legal/subprocessors",
      "/security",
      "/contact",
    ]) {
      expect(sitemap).toContain(`<loc>https://roamcode.ai${path}</loc>`);
    }
  });
});
