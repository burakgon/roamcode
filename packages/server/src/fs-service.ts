import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, sep, basename } from "node:path";
import { buildImageBlock } from "@remote-coder/protocol";
import type { ImageBlock } from "@remote-coder/protocol";

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

export class FsService {
  private readonly root: string;

  constructor(opts: FsServiceOptions) {
    this.root = resolve(opts.root);
  }

  /** Resolve a target (absolute or relative to root) and confine it to root. */
  resolveWithinRoot(target: string): string {
    const resolved = resolve(this.root, target);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new Error(`path is outside the allowed root: ${target}`);
    }
    return resolved;
  }

  async listDirectory(target: string): Promise<DirListing> {
    const dir = this.resolveWithinRoot(target);
    const dirStat = await stat(dir);
    if (!dirStat.isDirectory()) throw new Error(`not a directory: ${target}`);

    const dirents = await readdir(dir, { withFileTypes: true });
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
    const data = await readFile(file);
    return { filename: basename(file), data };
  }

  async writeUploadedFile(targetDir: string, filename: string, data: Buffer): Promise<{ path: string }> {
    if (filename.includes("/") || filename.includes("\\") || filename.includes(sep)) {
      throw new Error(`invalid upload filename (no path separators allowed): ${filename}`);
    }
    const dir = this.resolveWithinRoot(targetDir);
    const dest = this.resolveWithinRoot(join(dir, filename));
    await writeFile(dest, data);
    return { path: dest };
  }

  buildImageBlockFromUpload(mediaType: string, data: Buffer): ImageBlock {
    return buildImageBlock(mediaType, data.toString("base64"));
  }
}
