import { describe, expect, test } from "vitest";
import { providerDisplayName, providerSessionDisplay } from "./provider-display";

describe("provider display", () => {
  test("keeps built-in names stable and formats manifest-owned ids", () => {
    expect(providerDisplayName("claude")).toBe("Claude");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("review-agent")).toBe("Review Agent");
  });

  test("does not mislabel an unsupported legacy runtime as Claude", () => {
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

  test("does not invent launch or safety settings for an agent observed inside a shell", () => {
    expect(
      providerSessionDisplay({
        id: "shell",
        launch: { kind: "shell" },
        agent: { provider: "codex", source: "process", activity: "working", effort: "high" },
        provider: "codex",
        cwd: "/work",
        status: "running",
        createdAt: 1,
        dangerouslySkip: false,
      }),
    ).toEqual({
      provider: "Codex",
      model: undefined,
      effort: "high reasoning",
      dangerous: false,
      safety: ["agent-controlled settings"],
    });
  });
});
