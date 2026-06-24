import { describe, expect, it } from "vitest";
import { sortSessionsByActivity } from "./order";
import type { SessionMeta } from "../types/server";

function s(id: string, createdAt: number): SessionMeta {
  return { id, cwd: `/p/${id}`, dangerouslySkip: false, status: "running", createdAt };
}

describe("sortSessionsByActivity", () => {
  it("puts the most-recently-active session first", () => {
    const sessions = [s("a", 1), s("b", 2), s("c", 3)];
    const ordered = sortSessionsByActivity(sessions, { a: 100, b: 10, c: 50 });
    expect(ordered.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("falls back to createdAt when a session has no activity stamp", () => {
    const sessions = [s("a", 1), s("b", 5)];
    // No stamps at all → ordered by createdAt descending.
    expect(sortSessionsByActivity(sessions, {}).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("breaks ties on equal activity by createdAt descending", () => {
    const sessions = [s("old", 1), s("new", 9)];
    const ordered = sortSessionsByActivity(sessions, { old: 42, new: 42 });
    expect(ordered.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("does not mutate the input array", () => {
    const sessions = [s("a", 1), s("b", 2)];
    const snapshot = sessions.map((x) => x.id);
    sortSessionsByActivity(sessions, { a: 1, b: 99 });
    expect(sessions.map((x) => x.id)).toEqual(snapshot);
  });
});
