import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../types/server";
import { groupSessionsByAttention, sessionAttentionSection } from "./attention-groups";

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    cwd: `/work/${id}`,
    dangerouslySkip: false,
    status: "running",
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    ...overrides,
  };
}

describe("attention-first session grouping", () => {
  it("uses live agent activity with compatibility fallbacks", () => {
    expect(
      sessionAttentionSection(session("s1", { agent: { provider: "codex", source: "process", activity: "blocked" } })),
    ).toBe("need-you");
    expect(sessionAttentionSection(session("s2", { awaiting: true, activity: "idle" }))).toBe("need-you");
    expect(
      sessionAttentionSection(session("s3", { agent: { provider: "claude", source: "managed", activity: "working" } })),
    ).toBe("working");
    expect(sessionAttentionSection(session("s4", { status: "ended", activity: "working" }))).toBe("other");
  });

  it("returns every session exactly once while preserving the selected ordering within sections", () => {
    const sessions = [
      session("s1", { awaiting: true, createdAt: 1 }),
      session("s2", { activity: "working", createdAt: 2 }),
      session("s3", { activity: "idle", createdAt: 3 }),
      session("s4", { activity: "blocked", createdAt: 4 }),
      session("s5", { status: "ended", createdAt: 5 }),
    ];
    const grouped = groupSessionsByAttention(sessions, { s1: 10, s2: 20, s3: 30, s4: 40, s5: 50 }, "activity");

    expect(grouped.needYou.map((item) => item.id)).toEqual(["s4", "s1"]);
    expect(grouped.working.map((item) => item.id)).toEqual(["s2"]);
    expect(grouped.other.map((item) => item.id)).toEqual(["s5", "s3"]);
    expect([...grouped.needYou, ...grouped.working, ...grouped.other].map((item) => item.id).sort()).toEqual(
      sessions.map((item) => item.id).sort(),
    );
  });
});
