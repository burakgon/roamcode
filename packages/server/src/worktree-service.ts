import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 60_000;

export type WorktreeErrorCode =
  | "WORKTREE_OUTSIDE_ROOT"
  | "WORKTREE_INVALID_REF"
  | "WORKTREE_NOT_FOUND"
  | "WORKTREE_NOT_REGISTERED"
  | "WORKTREE_MAIN_PROTECTED"
  | "WORKTREE_DIRTY"
  | "WORKTREE_EXISTS"
  | "WORKTREE_GIT_FAILED"
  | "WORKTREE_TIMEOUT";

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeRecord {
  path: string;
  repositoryPath: string;
  branch?: string;
  head: string;
  dirty: boolean;
  changedFiles: number;
  isMain: boolean;
}

export interface CreateWorktreeInput {
  repositoryPath: string;
  path: string;
  branch?: string;
  baseRef?: string;
}

export interface CreateWorktreeResult {
  worktree: WorktreeRecord;
  created: boolean;
}

export interface WorktreeService {
  inspect(path: string): Promise<WorktreeRecord>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  remove(path: string, force?: boolean): Promise<WorktreeRecord>;
}

export interface CreateWorktreeServiceOptions {
  fsRoot: string;
  gitBin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type GitResult = { stdout: string; stderr: string; exitCode: number };

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\s~^:?*[\\\p{Cc}\p{Zl}\p{Zp}]/u.test(value) &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.includes("//")
  );
}

function parseWorktreePaths(output: string): string[] {
  return output
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export function createWorktreeService(options: CreateWorktreeServiceOptions): WorktreeService {
  const gitBin = options.gitBin ?? "git";
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
  let rootPromise: Promise<string> | undefined;
  const root = () => (rootPromise ??= realpath(resolve(options.fsRoot)));

  const confinedExisting = async (value: string): Promise<string> => {
    const candidate = await realpath(resolve(value)).catch(() => undefined);
    if (!candidate) throw new WorktreeError("WORKTREE_NOT_FOUND", "worktree path does not exist", 404);
    if (!inside(await root(), candidate)) {
      throw new WorktreeError("WORKTREE_OUTSIDE_ROOT", "worktree path is outside FS_ROOT", 403);
    }
    const info = await stat(candidate);
    if (!info.isDirectory()) throw new WorktreeError("WORKTREE_NOT_FOUND", "worktree path is not a directory", 404);
    return candidate;
  };

  const confinedTarget = async (value: string): Promise<string> => {
    const lexical = resolve(value);
    const parent = await realpath(dirname(lexical)).catch(() => undefined);
    if (!parent || !inside(await root(), parent)) {
      throw new WorktreeError("WORKTREE_OUTSIDE_ROOT", "worktree parent is outside FS_ROOT", 403);
    }
    const candidate = resolve(parent, basename(lexical));
    if (!inside(await root(), candidate)) {
      throw new WorktreeError("WORKTREE_OUTSIDE_ROOT", "worktree path is outside FS_ROOT", 403);
    }
    return candidate;
  };

  const runGit = async (cwd: string, args: string[], acceptExitCodes: number[] = [0]): Promise<GitResult> =>
    new Promise((resolveResult, reject) => {
      const child = spawn(gitBin, ["-C", cwd, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        if (current.length + chunk.length > maxOutputBytes) {
          child.kill("SIGKILL");
          fail(new WorktreeError("WORKTREE_GIT_FAILED", "git output exceeded the safety limit"));
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", () => fail(new WorktreeError("WORKTREE_GIT_FAILED", "git could not be started")));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const exitCode = code ?? -1;
        if (!acceptExitCodes.includes(exitCode)) {
          const operation = args.slice(0, 2).join(" ");
          reject(new WorktreeError("WORKTREE_GIT_FAILED", `git rejected ${operation || "the operation"}`, 409));
          return;
        }
        resolveResult({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode });
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new WorktreeError("WORKTREE_TIMEOUT", "git worktree operation timed out", 504));
      }, timeoutMs);
      timer.unref?.();
    });

  const inspect = async (path: string): Promise<WorktreeRecord> => {
    const candidate = await confinedExisting(path);
    const top = (await runGit(candidate, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const worktreePath = await realpath(top).catch(() => undefined);
    if (!worktreePath || worktreePath !== candidate) {
      throw new WorktreeError("WORKTREE_NOT_REGISTERED", "path must be a registered worktree root", 409);
    }
    const commonRaw = (await runGit(candidate, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const gitRaw = (await runGit(candidate, ["rev-parse", "--git-dir"])).stdout.trim();
    const commonDir = await realpath(resolve(candidate, commonRaw));
    const gitDir = await realpath(resolve(candidate, gitRaw));
    const repositoryPath = dirname(commonDir);
    if (!inside(await root(), repositoryPath)) {
      throw new WorktreeError("WORKTREE_OUTSIDE_ROOT", "repository metadata is outside FS_ROOT", 403);
    }
    const listed = parseWorktreePaths((await runGit(candidate, ["worktree", "list", "--porcelain", "-z"])).stdout);
    const registered = await Promise.all(listed.map((listedPath) => realpath(listedPath).catch(() => listedPath)));
    if (!registered.includes(candidate)) {
      throw new WorktreeError("WORKTREE_NOT_REGISTERED", "path is not registered by git worktree", 409);
    }
    const head = (await runGit(candidate, ["rev-parse", "HEAD"])).stdout.trim();
    const branchResult = await runGit(candidate, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]);
    // Git will happily remove a worktree containing only ignored files without --force. Those files can still
    // be valuable local state (for example an ignored signing fixture or database), so include matching ignored
    // paths in the safety decision. `matching` reports an ignored directory as one bounded entry instead of
    // recursively enumerating a large node_modules/build tree; the output cap fails closed if Git still floods.
    const statusResult = await runGit(candidate, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    const changedFiles = statusResult.stdout.split("\n").filter(Boolean).length;
    return {
      path: candidate,
      repositoryPath,
      ...(branchResult.exitCode === 0 && branchResult.stdout.trim() ? { branch: branchResult.stdout.trim() } : {}),
      head,
      dirty: changedFiles > 0,
      changedFiles,
      isMain: commonDir === gitDir,
    };
  };

  return {
    inspect,
    async create(input) {
      if (input.branch !== undefined && !validRef(input.branch)) {
        throw new WorktreeError("WORKTREE_INVALID_REF", "branch name is invalid");
      }
      if (input.baseRef !== undefined && !validRef(input.baseRef)) {
        throw new WorktreeError("WORKTREE_INVALID_REF", "base ref is invalid");
      }
      const repository = await inspect(input.repositoryPath);
      const target = await confinedTarget(input.path);
      const existing = await stat(target).catch(() => undefined);
      if (existing) {
        const worktree = await inspect(target).catch(() => undefined);
        if (
          worktree &&
          worktree.repositoryPath === repository.repositoryPath &&
          (input.branch === undefined || worktree.branch === input.branch)
        ) {
          return { worktree, created: false };
        }
        throw new WorktreeError("WORKTREE_EXISTS", "target already exists and is not the requested worktree", 409);
      }
      const args = ["worktree", "add"];
      if (input.branch) {
        const exists = await runGit(
          repository.path,
          ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
          [0, 1],
        );
        if (exists.exitCode === 0) args.push(target, input.branch);
        else args.push("-b", input.branch, target, input.baseRef ?? "HEAD");
      } else {
        args.push("--detach", target, input.baseRef ?? "HEAD");
      }
      await runGit(repository.path, args);
      return { worktree: await inspect(target), created: true };
    },
    async remove(path, force = false) {
      const worktree = await inspect(path);
      if (worktree.isMain) {
        throw new WorktreeError("WORKTREE_MAIN_PROTECTED", "the primary repository checkout cannot be removed", 409);
      }
      if (worktree.dirty && !force) {
        throw new WorktreeError(
          "WORKTREE_DIRTY",
          `worktree has ${worktree.changedFiles} changed file${worktree.changedFiles === 1 ? "" : "s"}`,
          409,
        );
      }
      await runGit(worktree.repositoryPath, ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path]);
      return worktree;
    },
  };
}
