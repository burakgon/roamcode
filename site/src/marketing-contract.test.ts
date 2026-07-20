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
    expect(page.querySelectorAll("[data-tour-tab]")).toHaveLength(3);
    expect(page.querySelectorAll("[data-tour-panel]")).toHaveLength(3);
    expect(page.querySelectorAll("[data-install-tab]")).toHaveLength(3);
    expect(page.querySelectorAll(".installer__steps li")).toHaveLength(3);
    expect(page.body.textContent).toContain("The installer waits for health, then prints a QR and pairing URL.");
    expect(page.body.textContent).not.toMatch(/star[s]? on github|github stars/iu);
    for (const asset of [
      "public/media/desktop.png",
      "public/media/split-desktop.png",
      "public/media/automations-desktop.png",
      "public/media/agents-desktop.png",
      "public/media/sessions-mobile.png",
      "public/media/automations-mobile.png",
      "public/media/agents-mobile.png",
      "public/media/terminal-mobile.png",
    ]) {
      expect(existsSync(asset), `${asset} should ship with the static site`).toBe(true);
    }
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
