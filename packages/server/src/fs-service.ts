import { readdir, readFile, writeFile, stat, realpath, lstat } from "node:fs/promises";
import { resolve, join, sep, basename } from "node:path";
import { buildImageBlock } from "@remote-coder/protocol";
import type { ImageBlock } from "@remote-coder/protocol";

export type FsErrorCode = "forbidden" | "not-found";

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

/**
 * The wire shape of an `attachment` server frame's payload (Claude sent a file to the chat).
 * Carries only the PATH — the web fetches the bytes via /fs/download — so a large file never
 * bloats the WS frame. Mirrored on the client in packages/web/src/types/server.ts.
 */
export interface AttachmentPayload {
  id: string;
  path: string;
  name: string;
  caption?: string;
  isImage: boolean;
}

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
    // Refuse to write THROUGH a pre-existing symlink at the destination (writeFile follows symlinks):
    // a symlink named `filename` — creatable by the running claude or a prior upload — could otherwise
    // redirect the write outside fsRoot. A regular file is fine to overwrite (a legit re-upload).
    try {
      const st = await lstat(dest);
      if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${filename}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await writeFile(dest, data);
    return { path: dest };
  }

  buildImageBlockFromUpload(mediaType: string, data: Buffer): ImageBlock {
    return buildImageBlock(mediaType, data.toString("base64"));
  }
}
