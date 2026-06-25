import { describe, expect, it } from "vitest";
import { pwaManifest } from "./manifest";

describe("pwaManifest", () => {
  it("is named Remote Coder and installs standalone", () => {
    expect(pwaManifest.name).toBe("Remote Coder");
    expect(pwaManifest.display).toBe("standalone");
    expect(pwaManifest.start_url).toBe("/");
  });

  it("uses the clean near-black --bg ink for theme + background", () => {
    expect(pwaManifest.theme_color).toBe("#0a0a0b");
    expect(pwaManifest.background_color).toBe("#0a0a0b");
  });

  it("ships a 192 and a maskable 512 svg icon", () => {
    const icons = pwaManifest.icons ?? [];
    const i192 = icons.find((i) => i.src === "icon-192.svg");
    const i512 = icons.find((i) => i.src === "icon-512.svg");
    expect(i192?.sizes).toBe("192x192");
    expect(i192?.type).toBe("image/svg+xml");
    expect(i512?.sizes).toBe("512x512");
    expect(i512?.purpose).toMatch(/maskable/);
  });
});
