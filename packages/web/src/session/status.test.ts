import { describe, expect, it } from "vitest";
import { wireStateForSession } from "./status";
import type { SessionMeta } from "../types/server";

function meta(status: SessionMeta["status"], extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id: "s", cwd: "/p", dangerouslySkip: false, status, createdAt: 1, ...extra };
}

describe("wireStateForSession", () => {
  it("maps errored -> error and stopped -> idle regardless of live view", () => {
    expect(wireStateForSession(meta("errored"), { wireState: "streaming" })).toBe("error");
    expect(wireStateForSession(meta("stopped"), { wireState: "streaming" })).toBe("idle");
  });
  it("uses the live view wireState for a running session", () => {
    expect(wireStateForSession(meta("running"), { wireState: "streaming" })).toBe("streaming");
    expect(wireStateForSession(meta("running"), undefined)).toBe("idle");
  });
  it("maps a dormant (clean-exit / resumable) session to the calm 'dormant' state, not error", () => {
    expect(wireStateForSession(meta("dormant"), { wireState: "streaming" })).toBe("dormant");
    expect(wireStateForSession(meta("dormant"), undefined)).toBe("dormant");
  });
  it("meta.awaiting ALWAYS wins (the loud awaiting state) — even over status and over a live view", () => {
    // Awaiting beats a running view's own wire state.
    expect(wireStateForSession(meta("running", { awaiting: true }), { wireState: "streaming" })).toBe("awaiting");
    // Awaiting works for a session WITHOUT a live view (it comes from the meta, not the view).
    expect(wireStateForSession(meta("running", { awaiting: true }), undefined)).toBe("awaiting");
    // Awaiting even beats a dormant/errored status (a pending prompt must always surface).
    expect(wireStateForSession(meta("dormant", { awaiting: true }), undefined)).toBe("awaiting");
  });
});
