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

test("buildImageBlockFromUpload returns a protocol image block", () => {
  const fs = new FsService({ root });
  const block = fs.buildImageBlockFromUpload("image/png", Buffer.from("PNGDATA"));
  expect(block.type).toBe("image");
  expect(block.source.media_type).toBe("image/png");
  expect(block.source.data).toBe(Buffer.from("PNGDATA").toString("base64"));
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
