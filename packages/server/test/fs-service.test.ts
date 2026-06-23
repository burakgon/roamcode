import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FsService } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-fs-"));
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

test("buildImageBlockFromUpload returns a protocol image block", () => {
  const fs = new FsService({ root });
  const block = fs.buildImageBlockFromUpload("image/png", Buffer.from("PNGDATA"));
  expect(block.type).toBe("image");
  expect(block.source.media_type).toBe("image/png");
  expect(block.source.data).toBe(Buffer.from("PNGDATA").toString("base64"));
});
