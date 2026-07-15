import { describe, expect, it } from "vitest";
import { apiNavigationDenylist } from "./sw-exclusions";

const matchesAny = (path: string) => apiNavigationDenylist.some((re) => re.test(path));

describe("apiNavigationDenylist", () => {
  it("denies the navigation fallback for the live API routes", () => {
    expect(matchesAny("/sessions")).toBe(true);
    expect(matchesAny("/sessions/abc/ws")).toBe(true);
    expect(matchesAny("/fs/list")).toBe(true);
    expect(matchesAny("/pairing/claim")).toBe(true);
    expect(matchesAny("/devices")).toBe(true);
  });

  it("does not deny app shell navigations", () => {
    expect(matchesAny("/")).toBe(false);
    expect(matchesAny("/index.html")).toBe(false);
  });
});
