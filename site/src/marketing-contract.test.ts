import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

function linkByText(root: ParentNode, label: string): HTMLAnchorElement | undefined {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a")).find((link) => link.textContent?.trim() === label);
}

describe("standalone marketing entry points", () => {
  test("sends every primary CTA to installation, the demo, or the public repository", () => {
    const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
    const header = page.querySelector('header nav[aria-label="Primary"]');
    const hero = page.querySelector(".hero .ctas");
    expect(header).not.toBeNull();
    expect(hero).not.toBeNull();
    expect(linkByText(header!, "Install")?.getAttribute("href")).toBe("#install-sec");
    expect(linkByText(hero!, "Install RoamCode")?.getAttribute("href")).toBe("#install-sec");
    expect(linkByText(hero!, "▶ Try the terminal")?.getAttribute("href")).toBe("#play-sec");
    expect(page.querySelector('a[href^="/app"]')).toBeNull();
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
