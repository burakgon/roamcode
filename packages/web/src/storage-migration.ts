/**
 * One-shot localStorage migration for the Remote Coder → RoamCode rename: every `remote-coder.*` key is
 * copied to its `roamcode.*` twin (existing new-name values win — never clobber fresher data), then the
 * legacy key is removed. Runs at boot BEFORE anything reads storage (main.tsx, ahead of loadTheme), so an
 * existing device keeps its token / theme / settings / recents across the rename instead of being signed out.
 *
 * Enumerates dynamically (prefix match) rather than from a key list, so any storage key this app ever
 * wrote under the old prefix is covered — including ones added after this file was written.
 */
const LEGACY_PREFIX = "remote-coder.";
const PREFIX = "roamcode.";

export function migrateLegacyStorage(
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
): void {
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(LEGACY_PREFIX)) legacyKeys.push(k);
    }
    for (const k of legacyKeys) {
      const next = PREFIX + k.slice(LEGACY_PREFIX.length);
      const value = storage.getItem(k);
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
      storage.removeItem(k);
    }
  } catch {
    // Storage unavailable (private mode / disabled) — nothing to migrate; the app degrades the same way
    // it does for every other storage read.
  }
}
