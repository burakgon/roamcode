import { describe, expect, it } from "vitest";
import { sortSessions } from "./order";
import type { SessionMeta } from "../types/server";

function s(id: string, createdAt: number, awaiting = false): SessionMeta {
  return { id, cwd: `/p/${id}`, dangerouslySkip: false, status: "running", createdAt, awaiting };
}

describe("sortSessions", () => {
  it("keeps created order stable when activity changes", () => {
    const sessions = [s("old", 1), s("new", 9)];
    expect(sortSessions(sessions, { old: 100, new: 10 }, "created").map((x) => x.id)).toEqual(["new", "old"]);
    expect(sortSessions(sessions, { old: 1000, new: 10 }, "created").map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("orders by recent activity when requested", () => {
    const sessions = [s("a", 1), s("b", 2), s("c", 3)];
    expect(sortSessions(sessions, { a: 100, b: 10, c: 50 }, "activity").map((x) => x.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it.each(["created", "activity"] as const)("pins awaiting sessions in %s mode", (order) => {
    const sessions = [s("new", 9), s("awaiting", 1, true)];
    expect(sortSessions(sessions, { new: 100, awaiting: 1 }, order).map((x) => x.id)).toEqual([
      "awaiting",
      "new",
    ]);
  });

  it("uses deterministic tie-breaks and does not mutate input", () => {
    const sessions = [s("b", 4), s("a", 4)];
    const snapshot = sessions.map((x) => x.id);
    expect(sortSessions(sessions, { a: 5, b: 5 }, "activity").map((x) => x.id)).toEqual(["a", "b"]);
    expect(sessions.map((x) => x.id)).toEqual(snapshot);
  });
});
