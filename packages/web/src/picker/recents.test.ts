import { afterEach, describe, expect, it } from "vitest";
import {
  dirBranch,
  isFavoriteDir,
  loadFavoriteDirs,
  loadRecentDirs,
  pushRecentDir,
  toggleFavoriteDir,
} from "./recents";

afterEach(() => localStorage.clear());

describe("recents", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(loadRecentDirs()).toEqual([]);
  });
  it("stores most-recent-first, deduped", () => {
    pushRecentDir("/a");
    pushRecentDir("/b");
    pushRecentDir("/a");
    expect(loadRecentDirs()).toEqual(["/a", "/b"]);
  });
  it("caps at 8", () => {
    for (let i = 0; i < 12; i++) pushRecentDir(`/p${i}`);
    expect(loadRecentDirs()).toHaveLength(8);
    expect(loadRecentDirs()[0]).toBe("/p11");
  });
  it("tolerates a corrupt stored value", () => {
    localStorage.setItem("remote-coder.recents", "{not json");
    expect(loadRecentDirs()).toEqual([]);
  });
  it("remembers a directory's git branch when pushed with one", () => {
    pushRecentDir("/repo", "main");
    expect(dirBranch("/repo")).toBe("main");
    // Pushing again with a newer branch updates the cache.
    pushRecentDir("/repo", "feature");
    expect(dirBranch("/repo")).toBe("feature");
  });
});

describe("favorites", () => {
  it("toggles a pin on and off, most-recent-first", () => {
    expect(loadFavoriteDirs()).toEqual([]);
    expect(toggleFavoriteDir("/a")).toEqual(["/a"]);
    expect(toggleFavoriteDir("/b")).toEqual(["/b", "/a"]);
    expect(isFavoriteDir("/a")).toBe(true);
    expect(toggleFavoriteDir("/a")).toEqual(["/b"]);
    expect(isFavoriteDir("/a")).toBe(false);
  });
  it("records the branch passed when pinning", () => {
    toggleFavoriteDir("/repo", "trunk");
    expect(dirBranch("/repo")).toBe("trunk");
  });
});
