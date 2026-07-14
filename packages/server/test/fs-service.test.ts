import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FsService, FsError } from "../src/index.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-fs-"));
  outside = mkdtempSync(join(tmpdir(), "rc-outside-"));
  // root/
  //   project-a/.git/HEAD            (a git repo on branch "main")
  //   plain-dir/
  //   notes.txt
  mkdirSync(join(root, "project-a", ".git"), { recursive: true });
  writeFileSync(join(root, "project-a", ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "plain-dir"));
  writeFileSync(join(root, "notes.txt"), "hello notes");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("listDirectory lists children, dirs first, marks git repos + branch", async () => {
  const fs = new FsService({ root });
  const listing = await fs.listDirectory(root);
  expect(listing.path).toBe(root);
  const names = listing.entries.map((e) => e.name);
  // directories first (project-a, plain-dir), then files (notes.txt)
  expect(names).toEqual(["plain-dir", "project-a", "notes.txt"]);
  const repo = listing.entries.find((e) => e.name === "project-a")!;
  expect(repo.isDirectory).toBe(true);
  expect(repo.isGitRepo).toBe(true);
  expect(repo.gitBranch).toBe("main");
  const plain = listing.entries.find((e) => e.name === "plain-dir")!;
  expect(plain.isGitRepo).toBe(false);
});

test("resolveWithinRoot rejects path traversal", () => {
  const fs = new FsService({ root });
  expect(() => fs.resolveWithinRoot("../../etc/passwd")).toThrow(/outside the allowed root/);
  expect(() => fs.resolveWithinRoot("/etc/passwd")).toThrow(/outside the allowed root/);
  // a legit child resolves fine
  expect(fs.resolveWithinRoot("plain-dir")).toBe(join(root, "plain-dir"));
});

test("readFileForDownload returns file bytes; traversal is blocked", async () => {
  const fs = new FsService({ root });
  const file = await fs.readFileForDownload(join(root, "notes.txt"));
  expect(file.filename).toBe("notes.txt");
  expect(file.data.toString("utf8")).toBe("hello notes");
  await expect(fs.readFileForDownload("../secret")).rejects.toThrow(/outside the allowed root/);
});

test("writeUploadedFile writes under root and rejects separators in the name", async () => {
  const fs = new FsService({ root });
  const out = await fs.writeUploadedFile(root, "upload.txt", Buffer.from("data"));
  expect(out.path).toBe(join(root, "upload.txt"));
  const back = await fs.readFileForDownload(out.path);
  expect(back.data.toString("utf8")).toBe("data");
  await expect(fs.writeUploadedFile(root, "../evil.txt", Buffer.from("x"))).rejects.toThrow();
  await expect(fs.writeUploadedFile(root, "sub/evil.txt", Buffer.from("x"))).rejects.toThrow();
});

test("a symlink inside root that points outside root is rejected (realpath defense)", async () => {
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  const svc = new FsService({ root });
  await expect(svc.readFileForDownload(join(root, "link.txt"))).rejects.toBeInstanceOf(FsError);
  await expect(svc.readFileForDownload(join(root, "link.txt"))).rejects.toMatchObject({ code: "forbidden" });
});

test("a missing file throws FsError with code not-found", async () => {
  const svc = new FsService({ root });
  await expect(svc.readFileForDownload(join(root, "nope.txt"))).rejects.toMatchObject({ code: "not-found" });
});

test("describeForAttachment returns name + isImage for an in-root file (image by extension)", async () => {
  writeFileSync(join(root, "shot.PNG"), "img-bytes");
  const fs = new FsService({ root });
  const png = await fs.describeForAttachment(join(root, "shot.PNG"));
  expect(png).toEqual({ name: "shot.PNG", isImage: true });
  const txt = await fs.describeForAttachment(join(root, "notes.txt"));
  expect(txt).toEqual({ name: "notes.txt", isImage: false });
});

test("describeForAttachment marks common raster/vector extensions as images", async () => {
  const fs = new FsService({ root });
  for (const ext of ["jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]) {
    writeFileSync(join(root, `a.${ext}`), "x");
    const d = await fs.describeForAttachment(join(root, `a.${ext}`));
    expect(d.isImage).toBe(true);
  }
});

test("describeForAttachment blocks traversal (forbidden) and a missing file (not-found)", async () => {
  const fs = new FsService({ root });
  await expect(fs.describeForAttachment("../../etc/passwd")).rejects.toMatchObject({ code: "forbidden" });
  await expect(fs.describeForAttachment(join(root, "nope.txt"))).rejects.toMatchObject({ code: "not-found" });
});

test("describeForAttachment rejects a symlink that escapes root (realpath defense)", async () => {
  writeFileSync(join(outside, "secret.png"), "TOP SECRET");
  symlinkSync(join(outside, "secret.png"), join(root, "esc.png"));
  const fs = new FsService({ root });
  await expect(fs.describeForAttachment(join(root, "esc.png"))).rejects.toMatchObject({ code: "forbidden" });
});

test("ensureDirWithinRoot creates a nested dir (confined to root) and rejects escapes", async () => {
  const fs = new FsService({ root });
  const created = await fs.ensureDirWithinRoot(join(root, "proj", "shared_files"));
  expect(created).toBe(join(root, "proj", "shared_files"));
  // idempotent
  await expect(fs.ensureDirWithinRoot(join(root, "proj", "shared_files"))).resolves.toBeTruthy();
  await expect(fs.ensureDirWithinRoot(outside)).rejects.toBeInstanceOf(FsError);
});

test("pruneOlderThan deletes only files older than maxAge (best-effort, dir may not exist)", async () => {
  const fs = new FsService({ root });
  const dir = join(root, "shared_files");
  mkdirSync(dir);
  writeFileSync(join(dir, "old.png"), "x");
  writeFileSync(join(dir, "fresh.png"), "y");
  const now = Date.now();
  // make old.png look 8 days old via utimes
  const eightDaysAgo = (now - 8 * 24 * 3600 * 1000) / 1000;
  const { utimesSync } = await import("node:fs");
  utimesSync(join(dir, "old.png"), eightDaysAgo, eightDaysAgo);
  const removed = await fs.pruneOlderThan(dir, 7 * 24 * 3600 * 1000, now);
  expect(removed).toBe(1);
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(dir, "old.png"))).toBe(false);
  expect(existsSync(join(dir, "fresh.png"))).toBe(true);
  // a non-existent dir is a no-op, not a throw
  await expect(fs.pruneOlderThan(join(root, "nope"), 1000)).resolves.toBe(0);
});

test("makeDirectory creates ONE dir (non-recursive), 'exists' on a taken path, confinement rejected", async () => {
  const fs = new FsService({ root });
  const created = await fs.makeDirectory(join(root, "new-project"));
  expect(created.path).toBe(join(root, "new-project"));
  const { existsSync } = await import("node:fs");
  expect(existsSync(join(root, "new-project"))).toBe(true);

  // Already exists → FsError("exists") (the route maps this to 409).
  await expect(fs.makeDirectory(join(root, "new-project"))).rejects.toMatchObject({ code: "exists" });
  // A missing parent is a client bug, not something to silently create (recursive:false by design).
  await expect(fs.makeDirectory(join(root, "no-such-parent", "child"))).rejects.toMatchObject({ code: "not-found" });
  // Escapes are forbidden exactly like every other fs route.
  await expect(fs.makeDirectory(join(outside, "evil"))).rejects.toMatchObject({ code: "forbidden" });
  await expect(fs.makeDirectory("../evil")).rejects.toMatchObject({ code: "forbidden" });
});

test("makeDirectory refuses a symlinked parent that escapes root (realpath defense)", async () => {
  symlinkSync(outside, join(root, "sneaky-link"));
  const fs = new FsService({ root });
  await expect(fs.makeDirectory(join(root, "sneaky-link", "child"))).rejects.toMatchObject({ code: "forbidden" });
});

test("searchDirectories: case-insensitive substring on DIR names, nested hits, node_modules + dot-dirs skipped", async () => {
  const fs = new FsService({ root });
  // root/apps/My-Widget           ← nested hit (depth 2)
  // root/widget-lib               ← top-level hit (depth 1) — must sort BEFORE the deeper one
  // root/node_modules/widget-x    ← must be skipped (inside node_modules)
  // root/.cache/widget-hidden     ← must be skipped (dot-dir)
  mkdirSync(join(root, "apps", "My-Widget"), { recursive: true });
  mkdirSync(join(root, "widget-lib"));
  mkdirSync(join(root, "node_modules", "widget-x"), { recursive: true });
  mkdirSync(join(root, ".cache", "widget-hidden"), { recursive: true });
  writeFileSync(join(root, "widget-notes.txt"), "files never match — dirs only");

  const results = await fs.searchDirectories("widget");
  expect(results.map((r) => r.path)).toEqual([join(root, "widget-lib"), join(root, "apps", "My-Widget")]);
  // Shallow-first ordering (BFS): the depth-1 hit precedes the depth-2 hit.
  expect(results[0]!.name).toBe("widget-lib");
  expect(results[1]!.name).toBe("My-Widget"); // matched case-insensitively
});

test("searchDirectories reports isGitRepo via the same .git/HEAD detection the lister uses", async () => {
  const fs = new FsService({ root });
  const results = await fs.searchDirectories("project");
  const repo = results.find((r) => r.name === "project-a");
  expect(repo?.isGitRepo).toBe(true);
  const plain = await fs.searchDirectories("plain");
  expect(plain[0]?.isGitRepo).toBe(false);
});

test("searchDirectories honors the depth cap (an entry at depth 6 is never found)", async () => {
  const fs = new FsService({ root });
  // a/b/c/d/deep-hit sits at depth 5 (findable); a/b/c/d/e/too-deep at depth 6 (beyond the cap).
  mkdirSync(join(root, "a", "b", "c", "d", "deep-hit"), { recursive: true });
  mkdirSync(join(root, "a", "b", "c", "d", "e", "too-deep"), { recursive: true });
  const found = await fs.searchDirectories("deep-hit");
  expect(found).toHaveLength(1);
  const tooDeep = await fs.searchDirectories("too-deep");
  expect(tooDeep).toEqual([]);
});

test("searchDirectories: base scopes the walk and is confined to root", async () => {
  const fs = new FsService({ root });
  mkdirSync(join(root, "scope-me", "target-dir"), { recursive: true });
  mkdirSync(join(root, "target-dir")); // outside the base — must NOT appear
  const scoped = await fs.searchDirectories("target", join(root, "scope-me"));
  expect(scoped.map((r) => r.path)).toEqual([join(root, "scope-me", "target-dir")]);
  await expect(fs.searchDirectories("x", "../..")).rejects.toMatchObject({ code: "forbidden" });
  await expect(fs.searchDirectories("x", join(root, "nope"))).rejects.toMatchObject({ code: "not-found" });
});

test("pruneChildDirsOlderThan ages out files in EACH session subdir (incl. orphans), skips fresh", async () => {
  const fs = new FsService({ root });
  const base = join(root, "terminal-shared");
  mkdirSync(join(base, "sessA"), { recursive: true });
  mkdirSync(join(base, "sessA", "upload-id"), { recursive: true });
  mkdirSync(join(base, "sessB"), { recursive: true }); // an "orphan" folder with no live session
  writeFileSync(join(base, "sessA", "old.png"), "x");
  writeFileSync(join(base, "sessA", "upload-id", "old-nested.png"), "z");
  writeFileSync(join(base, "sessB", "fresh.png"), "y");
  const now = Date.now();
  const eightDaysAgo = (now - 8 * 24 * 3600 * 1000) / 1000;
  const { utimesSync, existsSync } = await import("node:fs");
  utimesSync(join(base, "sessA", "old.png"), eightDaysAgo, eightDaysAgo);
  utimesSync(join(base, "sessA", "upload-id", "old-nested.png"), eightDaysAgo, eightDaysAgo);
  const removed = await fs.pruneChildDirsOlderThan(base, 7 * 24 * 3600 * 1000, now);
  expect(removed).toBe(2);
  expect(existsSync(join(base, "sessA", "old.png"))).toBe(false);
  expect(existsSync(join(base, "sessA", "upload-id", "old-nested.png"))).toBe(false);
  expect(existsSync(join(base, "sessA", "upload-id"))).toBe(false);
  expect(existsSync(join(base, "sessB", "fresh.png"))).toBe(true);
  // a non-existent base is a no-op, not a throw
  await expect(fs.pruneChildDirsOlderThan(join(root, "nope"), 1000)).resolves.toBe(0);
});

test("discoverManagedFiles finds legacy and current uploads without following links or partial files", async () => {
  const fs = new FsService({ root });
  const sessionDir = join(root, "terminal-shared", "sessA");
  mkdirSync(join(sessionDir, "upload-id", "too-deep"), { recursive: true });
  writeFileSync(join(sessionDir, "legacy.txt"), "legacy");
  writeFileSync(join(sessionDir, "upload-id", "photo.png"), "photo");
  writeFileSync(join(sessionDir, "upload-id", "ignored.partial"), "partial");
  writeFileSync(join(sessionDir, "upload-id", "too-deep", "deep.txt"), "deep");
  symlinkSync(join(outside, "missing.txt"), join(sessionDir, "linked.txt"));

  const files = await fs.discoverManagedFiles(sessionDir);

  expect(files.map((file) => file.path).sort()).toEqual(
    [join(sessionDir, "legacy.txt"), join(sessionDir, "upload-id", "photo.png")].sort(),
  );
  expect(files.map((file) => file.filename).sort()).toEqual(["legacy.txt", "photo.png"]);
  await expect(fs.discoverManagedFiles(join(root, "missing"))).resolves.toEqual([]);
});
