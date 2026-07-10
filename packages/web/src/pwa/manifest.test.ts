import { describe, expect, it } from "vitest";
import { pwaManifest } from "./manifest";

describe("pwaManifest", () => {
  it("is named RoamCode and installs standalone", () => {
    expect(pwaManifest.name).toBe("RoamCode");
    expect(pwaManifest.display).toBe("standalone");
    expect(pwaManifest.start_url).toBe("/");
  });

  it("uses the near-black --bg ink for theme and PURE black for the splash background", () => {
    // theme_color is runtime-managed (meta tag) — the manifest value stays the neutral ink.
    expect(pwaManifest.theme_color).toBe("#0a0a0b");
    // background_color paints the pre-boot splash: pure black, so OLED users never see the
    // near-black-on-black flash (the boot applies the real theme before first paint).
    expect(pwaManifest.background_color).toBe("#000000");
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
