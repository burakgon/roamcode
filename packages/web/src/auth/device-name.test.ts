import { describe, expect, test } from "vitest";
import { defaultDeviceName } from "./device-name";

describe("defaultDeviceName", () => {
  test("uses a human platform label without sending the full user agent", () => {
    expect(defaultDeviceName({ userAgent: "Mozilla iPhone", platform: "iPhone", maxTouchPoints: 5 })).toBe(
      "RoamCode on iPhone",
    );
    expect(defaultDeviceName({ userAgent: "Mozilla Android 16", platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(
      "RoamCode on Android",
    );
  });

  test("recognizes touch-reporting iPads that identify as Mac", () => {
    expect(defaultDeviceName({ userAgent: "Mozilla Macintosh", platform: "MacIntel", maxTouchPoints: 5 })).toBe(
      "RoamCode on iPad",
    );
  });
});
