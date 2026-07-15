import { describe, expect, test } from "vitest";
import { providerDisplayName, providerSessionDisplay } from "./provider-display";

describe("provider display", () => {
  test("keeps built-in names stable and formats manifest-owned ids", () => {
    expect(providerDisplayName("claude")).toBe("Claude");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("review-agent")).toBe("Review Agent");
  });

  test("does not mislabel an installed adapter as Claude", () => {
    expect(
      providerSessionDisplay({
        id: "s1",
        provider: "review-agent",
        cwd: "/work",
        status: "running",
        createdAt: 1,
        dangerouslySkip: false,
      }),
    ).toEqual({
      provider: "Review Agent",
      model: undefined,
      effort: undefined,
      dangerous: false,
      safety: ["adapter-managed safety"],
    });
  });
});
