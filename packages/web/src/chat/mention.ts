import { fuzzyFilter } from "../picker/fuzzy";
import type { DirEntry, DirListing } from "../types/server";

/**
 * @-FILE MENTIONS — the terminal's `@path` reference, brought to the contentEditable composer. This pure
 * module owns the TEXT mechanics (mirroring slash.ts): given the composer's text + caret it detects the
 * `@token` being typed, splits it into the directory to list and the basename prefix to filter, and
 * computes the replacement that inserting a chosen path produces. The Composer drives the async listDir
 * call + the menu UI; everything decidable from the text alone lives here so it's unit-testable.
 */

/** A live @-mention the user is typing at the caret. */
export interface MentionContext {
  /** Caret index where the `@` sits (the `@` is at `start`, the token text begins at `start + 1`). */
  start: number;
  /** Caret index just past the token (where the user is typing) — the replacement spans [start, end). */
  end: number;
  /** The directory part of the token to list (relative or absolute). "" means "list the session cwd". */
  dir: string;
  /** The basename prefix to filter the directory's entries by (may be ""). */
  prefix: string;
}

/**
 * Detect an `@token` being typed at the caret. Returns the mention context, or undefined when the caret
 * isn't inside an `@token`. The `@` triggers a mention when it's at the very start OR preceded by
 * whitespace (so an `email@host` mid-word does NOT open the picker, matching the terminal). The token
 * runs from the `@` up to the caret and must contain no whitespace (a space ends the reference).
 */
export function matchMention(text: string, caret: number): MentionContext | undefined {
  // Walk back from the caret to find the `@` that opens this token; bail on whitespace (the token ended).
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "@") break;
    if (/\s/.test(ch)) return undefined; // whitespace inside → not a contiguous @token
    i -= 1;
  }
  if (i < 0 || text[i] !== "@") return undefined;
  // The `@` must start the text or follow whitespace — otherwise it's a mid-word `@` (e.g. an email).
  const before = text[i - 1];
  if (before !== undefined && !/\s/.test(before)) return undefined;
  const token = text.slice(i + 1, caret);
  // A token may not contain whitespace (defensive — the back-walk already guarantees it for [i+1, caret)).
  if (/\s/.test(token)) return undefined;
  const { dir, prefix } = splitToken(token);
  return { start: i, end: caret, dir, prefix };
}

/**
 * Split an `@token` (the text after the `@`) into the DIRECTORY to list and the basename PREFIX to filter.
 * `src/ch` → list "src", filter "ch". `src/` → list "src", filter "". `comp` → list "" (cwd), filter
 * "comp". An absolute `"/Users/x/co"` → list "/Users/x", filter "co" (and a bare `"/"` lists root).
 */
export function splitToken(token: string): { dir: string; prefix: string } {
  const slash = token.lastIndexOf("/");
  if (slash < 0) return { dir: "", prefix: token };
  // Keep a leading-slash dir as "/" (root) rather than collapsing it to "".
  const dir = token.slice(0, slash) || (token.startsWith("/") ? "/" : "");
  const prefix = token.slice(slash + 1);
  return { dir, prefix };
}

/**
 * Resolve the directory part of a mention to the ABSOLUTE path to hand to listDir, anchored at the
 * session `cwd`. An absolute dir (starts with `/`) is used as-is; a relative dir is joined onto cwd;
 * an empty dir lists cwd itself. Tolerates a trailing slash on cwd.
 */
export function resolveMentionDir(cwd: string, dir: string): string {
  if (dir.startsWith("/")) return dir;
  const base = cwd.replace(/\/+$/, "");
  return dir ? `${base}/${dir}` : base;
}

/** Filter a directory listing's entries by the basename prefix (fuzzy, like the DirectoryPicker). Files
 *  AND directories are both offered (a mention can target either); empty prefix → all entries in order. */
export function filterMentionEntries(listing: DirListing, prefix: string): DirEntry[] {
  return fuzzyFilter(listing.entries, prefix);
}

/**
 * The TEXT this entry inserts when chosen: the `@token` is replaced by `@<path>` where `<path>` is the
 * directory part rejoined with the entry's name. A directory inserts with a TRAILING SLASH so the user
 * can keep drilling (re-triggering the picker); a file inserts a trailing SPACE so the reference is
 * complete and typing continues cleanly. The path is kept RELATIVE/ABSOLUTE exactly as the user was
 * typing it (the `dir` they typed), so `@src/Comp` → `@src/Composer.tsx ` and `@/abs/Comp` stays absolute.
 */
export function mentionInsertion(ctx: MentionContext, entry: DirEntry): string {
  const path = ctx.dir ? `${ctx.dir}/${entry.name}` : entry.name;
  return entry.isDirectory ? `@${path}/` : `@${path} `;
}
