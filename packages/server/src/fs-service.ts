import { createWriteStream } from "node:fs";
import { readdir, readFile, stat, realpath, open, mkdir, unlink, rename, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, sep, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

export type FsErrorCode = "forbidden" | "not-found" | "exists";

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = "FsError";
    this.code = code;
  }
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

export interface FsServiceOptions {
  root: string;
}

/** One GET /fs/search hit — a DIRECTORY whose name matched, shaped for the picker. */
export interface DirSearchResult {
  path: string;
  name: string;
  isGitRepo: boolean;
}

/** GET /fs/search walk bounds. Depth 5 / 400 dirs keeps the worst case (a huge home dir) to a bounded,
 *  sub-second readdir sweep; 30 results is more than a picker list ever shows. */
export const SEARCH_MAX_DEPTH = 5;
export const SEARCH_MAX_DIRS = 400;
export const SEARCH_MAX_RESULTS = 30;

/** Extensions rendered inline as images (lowercased, no dot). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function isImagePath(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export class FsService {
  private readonly root: string;

  constructor(opts: FsServiceOptions) {
    this.root = resolve(opts.root);
  }

  /** Resolve a target (absolute or relative to root) and confine it to root. */
  resolveWithinRoot(target: string): string {
    const resolved = resolve(this.root, target);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new FsError("forbidden", `path is outside the allowed root: ${target}`);
    }
    return resolved;
  }

  /** Resolve real paths so a symlink inside root cannot point outside it. Missing -> not-found. */
  private async realWithinRoot(resolvedPath: string): Promise<string> {
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await realpath(this.root);
    } catch {
      realRoot = this.root;
    }
    try {
      realTarget = await realpath(resolvedPath);
    } catch {
      throw new FsError("not-found", `not found: ${resolvedPath}`);
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new FsError("forbidden", `path resolves outside the allowed root`);
    }
    return realTarget;
  }

  async listDirectory(target: string): Promise<DirListing> {
    const dir = this.resolveWithinRoot(target);
    const realDir = await this.realWithinRoot(dir);
    const dirStat = await stat(realDir);
    if (!dirStat.isDirectory()) throw new Error(`not a directory: ${target}`);

    const dirents = await readdir(realDir, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      const full = join(dir, d.name);
      const isDirectory = d.isDirectory();
      let isGitRepo = false;
      let gitBranch: string | undefined;
      if (isDirectory) {
        gitBranch = await this.readGitBranch(full);
        isGitRepo = gitBranch !== undefined;
      }
      entries.push({ name: d.name, path: full, isDirectory, isGitRepo, gitBranch });
    }

    // Directories first, then files; each group name-sorted.
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = dir === this.root ? undefined : resolve(dir, "..");
    return { path: dir, parent, entries };
  }

  /** Read .git/HEAD cheaply; return the branch name or undefined if not a repo. */
  private async readGitBranch(dirPath: string): Promise<string | undefined> {
    try {
      const head = await readFile(join(dirPath, ".git", "HEAD"), "utf8");
      const m = /^ref:\s+refs\/heads\/(.+)\s*$/.exec(head.trim());
      if (m) return m[1];
      // Detached HEAD: return the short commit.
      return head.trim().slice(0, 8);
    } catch {
      return undefined;
    }
  }

  async readFileForDownload(target: string): Promise<{ filename: string; data: Buffer }> {
    const file = this.resolveWithinRoot(target);
    const real = await this.realWithinRoot(file);
    const data = await readFile(real);
    return { filename: basename(file), data };
  }

  /** Validate and describe a real in-root file without reading it into memory. */
  async describeFile(target: string): Promise<{ path: string; filename: string; size: number; mtimeMs: number }> {
    const file = this.resolveWithinRoot(target);
    const real = await this.realWithinRoot(file);
    const info = await stat(real);
    if (!info.isFile()) throw new FsError("not-found", `not a file: ${target}`);
    return { path: real, filename: basename(file), size: info.size, mtimeMs: info.mtimeMs };
  }

  /**
   * Validate that `target` is a real in-root file and describe it for an attachment frame WITHOUT
   * reading its bytes. Reuses the same resolveWithinRoot + realpath defense as readFileForDownload so
   * a traversal/symlink-escape path throws FsError("forbidden") and a missing path FsError("not-found").
   */
  async describeForAttachment(target: string): Promise<{ name: string; isImage: boolean }> {
    const file = this.resolveWithinRoot(target);
    await this.realWithinRoot(file);
    const name = basename(file);
    return { name, isImage: isImagePath(name) };
  }

  async writeUploadedFile(targetDir: string, filename: string, data: Buffer): Promise<{ path: string }> {
    if (filename.includes("/") || filename.includes("\\") || filename.includes(sep)) {
      throw new Error(`invalid upload filename (no path separators allowed): ${filename}`);
    }
    const dir = this.resolveWithinRoot(targetDir);
    // Realpath the TARGET DIR (the file does not exist yet) so a symlinked dir cannot escape root.
    await this.realWithinRoot(dir);
    const dest = this.resolveWithinRoot(join(dir, filename));
    // Refuse to write THROUGH a symlink at the destination (a plain writeFile follows symlinks): a
    // symlink named `filename` — creatable by the running claude or a prior upload — could otherwise
    // redirect the write outside fsRoot. O_NOFOLLOW makes open() fail (ELOOP) if the final component is a
    // symlink — ATOMICALLY, with no check-then-write (TOCTOU) gap a concurrent swap could exploit. A
    // regular file is still overwritten (O_TRUNC) — a legit re-upload.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
    let fh;
    try {
      fh = await open(dest, flags, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`refusing to write through a symlink: ${filename}`);
      }
      throw err;
    }
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    return { path: dest };
  }

  /** Stream an upload to a same-directory partial and atomically publish it. The caller owns size limits;
   *  this method guarantees an interrupted upload never leaves a visible half-file. */
  async writeUploadedStream(
    targetDir: string,
    filename: string,
    input: NodeJS.ReadableStream,
    beforeCommit?: () => boolean,
  ): Promise<{ path: string; size: number }> {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes(sep)) {
      throw new Error(`invalid upload filename (no path separators allowed): ${filename}`);
    }
    const dir = this.resolveWithinRoot(targetDir);
    await this.realWithinRoot(dir);
    const dest = this.resolveWithinRoot(join(dir, filename));
    const partial = this.resolveWithinRoot(join(dir, `.upload-${randomUUID()}.partial`));
    try {
      await pipeline(
        input as NodeJS.ReadableStream & AsyncIterable<Uint8Array>,
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      if (beforeCommit && !beforeCommit()) throw new Error("upload stream rejected before commit");
      await rename(partial, dest);
      const info = await stat(dest);
      return { path: dest, size: info.size };
    } catch (err) {
      await unlink(partial).catch(() => undefined);
      throw err;
    }
  }

  /** Atomically replace one existing in-root managed file with streamed bytes. */
  async replaceFileStream(
    target: string,
    input: NodeJS.ReadableStream,
    beforeCommit?: () => boolean,
  ): Promise<{ path: string; size: number }> {
    const file = this.resolveWithinRoot(target);
    const real = await this.realWithinRoot(file);
    const parent = resolve(real, "..");
    await this.realWithinRoot(parent);
    const partial = join(parent, `.edit-${randomUUID()}.partial`);
    try {
      await pipeline(
        input as NodeJS.ReadableStream & AsyncIterable<Uint8Array>,
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      if (beforeCommit && !beforeCommit()) throw new Error("replacement stream rejected before commit");
      await rename(partial, real);
      const info = await stat(real);
      return { path: real, size: info.size };
    } catch (err) {
      await unlink(partial).catch(() => undefined);
      throw err;
    }
  }

  /** Best-effort removal used only for server-owned managed attachment copies. */
  async removeManagedPath(target: string): Promise<void> {
    const file = this.resolveWithinRoot(target);
    const real = await this.realWithinRoot(file);
    await unlink(real);
    await rmdir(resolve(real, "..")).catch(() => undefined);
  }

  /** Discover regular files in an app-owned directory for one-time legacy attachment backfill. Symlinks
   *  are ignored and traversal is deliberately shallow: old uploads are direct children, current uploads
   *  add exactly one id directory. */
  async discoverManagedFiles(
    target: string,
    maxDepth = 1,
  ): Promise<Array<{ path: string; filename: string; size: number; mtimeMs: number }>> {
    let root: string;
    try {
      root = this.resolveWithinRoot(target);
      await this.realWithinRoot(root);
    } catch {
      return [];
    }
    const found: Array<{ path: string; filename: string; size: number; mtimeMs: number }> = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name.endsWith(".partial")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth) await walk(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = await stat(path);
          found.push({ path, filename: entry.name, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          /* a concurrently removed file simply is not backfilled */
        }
      }
    };
    await walk(root, 0);
    return found;
  }

  /** Ensure a directory (confined to root) exists, creating parents as needed; returns its absolute path. */
  async ensureDirWithinRoot(target: string): Promise<string> {
    const dir = this.resolveWithinRoot(target);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * POST /fs/mkdir: create ONE new directory (recursive:false — the picker creates a single folder under
   * an existing parent; a missing parent is a client bug, not something to silently paper over). Same
   * confinement as listDirectory: resolveWithinRoot on the target + realpath on the PARENT (the target
   * itself doesn't exist yet), so a symlinked parent can't smuggle the create outside root.
   * Errors: "exists" (→409) when the path is already taken, "not-found" (→404) when the parent is
   * missing, "forbidden" (→403) on any escape.
   */
  async makeDirectory(target: string): Promise<{ path: string }> {
    const dir = this.resolveWithinRoot(target);
    if (dir === this.root) throw new FsError("exists", `directory already exists: ${target}`);
    await this.realWithinRoot(resolve(dir, "..")); // parent must be a real, in-root location
    try {
      await mkdir(dir, { recursive: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new FsError("exists", `directory already exists: ${target}`);
      if (code === "ENOENT") throw new FsError("not-found", `parent directory does not exist: ${target}`);
      throw err;
    }
    return { path: dir };
  }

  /**
   * GET /fs/search: case-insensitive SUBSTRING match on DIRECTORY names under `base` (default root),
   * for the project picker's "type to find your repo" flow. Breadth-first — so results come back
   * shallowest-first without a sort — bounded by {@link SEARCH_MAX_DEPTH} / {@link SEARCH_MAX_DIRS} /
   * {@link SEARCH_MAX_RESULTS} so a giant tree can never wedge the request. Dot-entries and node_modules
   * are skipped (never a project root; node_modules alone would blow the dir budget). Unreadable dirs are
   * skipped, not fatal. Same fsRoot confinement as every other fs route; entries are reported by their
   * in-root path (symlinked children are NOT re-resolved — mirroring listDirectory).
   */
  async searchDirectories(query: string, base?: string): Promise<DirSearchResult[]> {
    const start = this.resolveWithinRoot(base ?? this.root);
    const realStart = await this.realWithinRoot(start); // must exist + confinement (throws not-found/forbidden)
    if (!(await stat(realStart)).isDirectory()) {
      throw new FsError("not-found", `not a directory: ${base ?? this.root}`);
    }
    const needle = query.toLowerCase();
    const results: DirSearchResult[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < SEARCH_MAX_DIRS && results.length < SEARCH_MAX_RESULTS) {
      const { dir, depth } = queue.shift()!;
      visited += 1;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // permission denied / vanished mid-walk — skip, never fail the search
      }
      // Name-sorted so results are deterministic within a depth level (BFS handles the between-levels order).
      const dirs = dirents.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        if (d.name.startsWith(".") || d.name === "node_modules") continue;
        const full = join(dir, d.name);
        if (d.name.toLowerCase().includes(needle)) {
          results.push({ path: full, name: d.name, isGitRepo: (await this.readGitBranch(full)) !== undefined });
          if (results.length >= SEARCH_MAX_RESULTS) break;
        }
        // Children found while reading a depth-d dir sit at depth d+1; only descend while that stays <= max.
        if (depth + 1 < SEARCH_MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      }
    }
    return results;
  }

  /** Prune expired files inside EACH immediate subdirectory of `base` (confined to root). Used to age out
   *  the terminal shared-files folders (one per session) in a single sweep — including ORPHANED folders
   *  whose session no longer exists (the old per-live-session sweep leaked those forever). Best-effort:
   *  returns the total files removed; a missing base / unreadable entry is skipped, not thrown. */
  async pruneChildDirsOlderThan(base: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
    let dir: string;
    try {
      dir = this.resolveWithinRoot(base);
    } catch {
      return 0;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0; // base doesn't exist yet (nothing uploaded)
    }
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      removed += await this.pruneOlderThan(join(dir, e.name), maxAgeMs, now, true);
    }
    return removed;
  }

  /** Delete top-level regular files in `target` (confined to root) whose mtime is older than `maxAgeMs`.
   *  Best-effort — returns how many were removed; a missing dir / unreadable entry is skipped, not thrown.
   *  Subdirectories are left untouched. Used to give terminal shared-files uploads a bounded lifetime. */
  async pruneOlderThan(target: string, maxAgeMs: number, now: number = Date.now(), recursive = false): Promise<number> {
    let dir: string;
    try {
      dir = this.resolveWithinRoot(target);
    } catch {
      return 0;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0; // dir doesn't exist (nothing uploaded yet)
    }
    let removed = 0;
    for (const entry of entries) {
      const p = join(dir, entry.name);
      try {
        if (recursive && entry.isDirectory()) {
          removed += await this.pruneOlderThan(p, maxAgeMs, now, true);
          await rmdir(p).catch(() => undefined);
          continue;
        }
        const s = await stat(p);
        if (s.isFile() && now - s.mtimeMs > maxAgeMs) {
          await unlink(p);
          removed += 1;
        }
      } catch {
        /* skip an entry we can't stat/remove */
      }
    }
    return removed;
  }
}
