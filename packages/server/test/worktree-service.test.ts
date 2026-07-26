import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorktreeService, WorktreeError } from "../src/worktree-service.js";

const exec = promisify(execFile);
let root: string;
let repository: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roamcode-worktree-"));
  root = await realpath(root);
  repository = join(root, "repository");
  await exec("git", ["init", repository]);
  await writeFile(join(repository, "README.md"), "hello\n", "utf8");
  await writeFile(join(repository, ".gitignore"), "ignored.txt\n", "utf8");
  await exec("git", ["-C", repository, "add", "README.md", ".gitignore"]);
  await exec("git", [
    "-C",
    repository,
    "-c",
    "user.name=RoamCode Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  repository = await realpath(repository);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("guarded worktree service", () => {
  test("creates idempotently, reports dirty state, and refuses unsafe removal", async () => {
    const service = createWorktreeService({ fsRoot: root });
    const target = join(root, "feature-checkout");
    const first = await service.create({ repositoryPath: repository, path: target, branch: "feature/product" });
    expect(first).toMatchObject({ created: true, worktree: { path: target, branch: "feature/product", dirty: false } });
    expect(
      (await service.create({ repositoryPath: repository, path: target, branch: "feature/product" })).created,
    ).toBe(false);

    await writeFile(join(target, "draft.txt"), "uncommitted\n", "utf8");
    await expect(service.remove(target)).rejects.toMatchObject<Partial<WorktreeError>>({ code: "WORKTREE_DIRTY" });
    expect((await stat(target)).isDirectory()).toBe(true);
    const removed = await service.remove(target, true);
    expect(removed).toMatchObject({ dirty: true, changedFiles: 1 });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("protects the primary checkout, path boundary, and ref arguments", async () => {
    const service = createWorktreeService({ fsRoot: root });
    expect(await service.inspect(repository)).toMatchObject({ isMain: true, repositoryPath: repository });
    await expect(service.remove(repository, true)).rejects.toMatchObject<Partial<WorktreeError>>({
      code: "WORKTREE_MAIN_PROTECTED",
    });
    await expect(
      service.create({ repositoryPath: repository, path: join(root, "bad"), branch: "--upload-pack=oops" }),
    ).rejects.toMatchObject<Partial<WorktreeError>>({ code: "WORKTREE_INVALID_REF" });
    await expect(
      service.create({ repositoryPath: repository, path: join(root, "..", "escaped"), branch: "safe" }),
    ).rejects.toMatchObject<Partial<WorktreeError>>({ code: "WORKTREE_OUTSIDE_ROOT" });
    await symlink(tmpdir(), join(root, "symlinked-parent"));
    await expect(
      service.create({ repositoryPath: repository, path: join(root, "symlinked-parent", "escaped"), branch: "safe" }),
    ).rejects.toMatchObject<Partial<WorktreeError>>({ code: "WORKTREE_OUTSIDE_ROOT" });
  });

  test("treats ignored files as valuable local state and never removes them without force", async () => {
    const service = createWorktreeService({ fsRoot: root });
    const target = join(root, "ignored-state-checkout");
    await service.create({ repositoryPath: repository, path: target, branch: "feature/ignored-state" });
    await writeFile(join(target, "ignored.txt"), "local-only value\n", "utf8");

    await expect(service.inspect(target)).resolves.toMatchObject({ dirty: true, changedFiles: 1 });
    await expect(service.remove(target)).rejects.toMatchObject<Partial<WorktreeError>>({ code: "WORKTREE_DIRTY" });
    await expect(stat(join(target, "ignored.txt"))).resolves.toBeDefined();
    await service.remove(target, true);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("creates a project-scoped managed worktree and preserves the repository subfolder", async () => {
    const projectPath = join(repository, "apps", "web");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, "package.json"), "{}\n", "utf8");
    await exec("git", ["-C", repository, "add", "apps/web/package.json"]);
    await exec("git", [
      "-C",
      repository,
      "-c",
      "user.name=RoamCode Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "add nested project",
    ]);

    const service = createWorktreeService({ fsRoot: root });
    const described = await service.describeProject(projectPath);
    expect(described).toMatchObject({ projectPath, relativePath: join("apps", "web") });

    const first = await service.createManaged({ projectPath, branch: "feature/mobile-navigation" });
    expect(first.created).toBe(true);
    expect(first.worktree.branch).toBe("feature/mobile-navigation");
    expect(first.worktree.path.startsWith(`${repository}.worktrees/`)).toBe(true);
    expect(first.projectPath).toBe(join(first.worktree.path, "apps", "web"));
    expect((await stat(first.projectPath)).isDirectory()).toBe(true);

    const recovered = await service.createManaged({ projectPath, branch: "feature/mobile-navigation" });
    expect(recovered).toMatchObject({
      created: false,
      projectPath: first.projectPath,
      worktree: { path: first.worktree.path, branch: "feature/mobile-navigation" },
    });
    await service.remove(first.worktree.path);
  });
});
