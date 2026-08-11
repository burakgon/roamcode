import { afterEach, describe, expect, it } from "vitest";
import {
  clearRecents,
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
    localStorage.setItem("roamcode.recents", "{not json");
    expect(loadRecentDirs()).toEqual([]);
  });
  it("clearRecents empties recents but keeps favorites", () => {
    pushRecentDir("/a");
    pushRecentDir("/b");
    toggleFavoriteDir("/fav");
    clearRecents();
    expect(loadRecentDirs()).toEqual([]);
    expect(loadFavoriteDirs()).toEqual(["/fav"]);
    // Recents start repopulating again afterwards.
    pushRecentDir("/c");
    expect(loadRecentDirs()).toEqual(["/c"]);
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
});
