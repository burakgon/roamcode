import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function linkByText(root: ParentNode, label: string): HTMLAnchorElement | undefined {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a")).find((link) => link.textContent?.trim() === label);
}

describe("standalone marketing entry points", () => {
  test("sends every primary CTA to installation, the product tour, or the public repository", () => {
    const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
    const header = page.querySelector(".topbar__actions");
    const hero = page.querySelector(".hero__actions");
    expect(header).not.toBeNull();
    expect(hero).not.toBeNull();
    expect(linkByText(header!, "Install")?.getAttribute("href")).toBe("#install-sec");
    expect(linkByText(hero!, "Install RoamCode")?.getAttribute("href")).toBe("#install-sec");
    expect(linkByText(hero!, "See the product")?.getAttribute("href")).toBe("#product");
    expect(page.querySelector('a[href^="/app"]')).toBeNull();
  });

  test("shows the real product surfaces and a complete first-session path", () => {
    const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
    expect(page.querySelectorAll(".showcase-index a")).toHaveLength(4);
    expect(page.querySelectorAll(".phone-feature")).toHaveLength(5);
    expect(page.querySelector('.phone-feature:first-child img[src="/media/automations-mobile.png"]')).not.toBeNull();
    expect(page.querySelector(".phone-feature:first-child img")?.getAttribute("alt")).toContain("bottom navigation");
    expect(page.querySelectorAll("[data-tour-tab], [data-tour-panel]")).toHaveLength(0);
    expect(page.querySelector('#sessions-showcase img[src="/media/split-desktop.png"]')).not.toBeNull();
    expect(page.querySelector('#automations-showcase img[src="/media/automations-desktop.png"]')).not.toBeNull();
    expect(page.querySelector('#agents-showcase img[src="/media/agents-desktop.png"]')).not.toBeNull();
    for (const image of page.querySelectorAll<HTMLImageElement>(".showcase-window img, .phone-feature img")) {
      expect(image.getAttribute("alt")?.trim().length).toBeGreaterThan(10);
    }
    expect(page.querySelectorAll("[data-install-tab]")).toHaveLength(3);
    expect(page.querySelectorAll(".installer__steps li")).toHaveLength(3);
    expect(page.body.textContent).toContain("The installer waits for health, then prints a QR and pairing URL.");
    expect(page.body.textContent).not.toMatch(/star[s]? on github|github stars/iu);
    for (const asset of [
      "public/media/desktop.png",
      "public/media/split-desktop.png",
      "public/media/automations-desktop.png",
      "public/media/agents-desktop.png",
      "public/media/automations-mobile.png",
      "public/media/agents-mobile.png",
      "public/media/terminal-mobile.png",
      "public/media/keybar-mobile.png",
      "public/media/files-mobile.png",
      "public/media/newsession-mobile.png",
    ]) {
      expect(existsSync(asset), `${asset} should ship with the static site`).toBe(true);
    }
  });

  test("preserves screenshot proportions and keeps GitHub reachable on mobile", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/\.product-frame\s*>\s*img\s*\{[^}]*height:\s*auto;/su);
    expect(styles).toMatch(/\.phone-feature__device\s+img\s*\{[^}]*height:\s*auto;/su);
    expect(styles).not.toContain(".topbar__github {\n    display: none;");

    const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
    expect(linkByText(page.querySelector(".topbar__actions")!, "GitHub")?.getAttribute("href")).toBe(
      "https://github.com/burakgon/roamcode",
    );
  });

  test("describes a standalone service with no hosted dependency", () => {
    const source = readFileSync("index.html", "utf8");
    expect(source).toContain("RoamCode has no hosted dependency");
    expect(source).not.toMatch(/sign in|create account|cloud service|blind relay/iu);
  });

  test("publishes only the public marketing root in the sitemap", () => {
    const sitemap = readFileSync("public/sitemap.xml", "utf8");
    expect(sitemap.match(/<loc>/g)).toHaveLength(1);
    expect(sitemap).toContain("<loc>https://roamcode.ai/</loc>");
  });
});
