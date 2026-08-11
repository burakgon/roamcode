const KEY = "roamcode.recents";
const FAV_KEY = "roamcode.favorites";
const CAP = 8;

export function loadRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecentDir(path: string): void {
  const current = loadRecentDirs().filter((p) => p !== path);
  const next = [path, ...current].slice(0, CAP);
  localStorage.setItem(KEY, JSON.stringify(next));
}

/** Wipe the recents list. Favorites are stored separately and deliberately untouched. */
export function clearRecents(): void {
  localStorage.removeItem(KEY);
}

/** Pinned/favorite directories — shown at the very top of the picker, ahead of recents. Persisted
 *  separately so a pin survives even after the path rolls off the (capped) recents list. */
export function loadFavoriteDirs(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

export function isFavoriteDir(path: string): boolean {
  return loadFavoriteDirs().includes(path);
}

/** Pin/unpin a directory. Returns the new favorites list so callers can update state without a reload. */
export function toggleFavoriteDir(path: string): string[] {
  const current = loadFavoriteDirs();
  const next = current.includes(path) ? current.filter((p) => p !== path) : [path, ...current];
  localStorage.setItem(FAV_KEY, JSON.stringify(next));
  return next;
}
