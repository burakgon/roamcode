const KEY = "remote-coder.recents";
const FAV_KEY = "remote-coder.favorites";
const BRANCH_KEY = "remote-coder.dir-branches";
const CAP = 8;
// The git-branch cache is a convenience label only (it can go stale), so keep it small and bounded.
const BRANCH_CAP = 64;

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

export function pushRecentDir(path: string, branch?: string): void {
  const current = loadRecentDirs().filter((p) => p !== path);
  const next = [path, ...current].slice(0, CAP);
  localStorage.setItem(KEY, JSON.stringify(next));
  // Remember the branch alongside so the picker can label recents/favorites the next time round.
  if (branch) recordDirBranch(path, branch);
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
export function toggleFavoriteDir(path: string, branch?: string): string[] {
  const current = loadFavoriteDirs();
  const next = current.includes(path) ? current.filter((p) => p !== path) : [path, ...current];
  localStorage.setItem(FAV_KEY, JSON.stringify(next));
  if (branch) recordDirBranch(path, branch);
  return next;
}

/** Remember the git branch last seen for a directory, so recents/favorites (which are bare paths) can
 *  still show a branch chip. Bounded — oldest entries are dropped past BRANCH_CAP. */
export function recordDirBranch(path: string, branch?: string): void {
  if (!branch) return;
  try {
    const map = loadDirBranches();
    // Re-insert at the end (most-recent-last) so the trim below drops the stalest entries.
    delete map[path];
    map[path] = branch;
    const keys = Object.keys(map);
    if (keys.length > BRANCH_CAP) {
      for (const k of keys.slice(0, keys.length - BRANCH_CAP)) delete map[k];
    }
    localStorage.setItem(BRANCH_KEY, JSON.stringify(map));
  } catch {
    /* best-effort cache */
  }
}

export function loadDirBranches(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BRANCH_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The cached git branch for a directory, if we've seen one. */
export function dirBranch(path: string): string | undefined {
  return loadDirBranches()[path];
}
