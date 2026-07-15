import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const context = input ? JSON.parse(input) : {};
const branch = String(context.branch ?? "");
const baseRef = String(context.baseRef ?? "HEAD");
const targetInput = String(context.target ?? "");
const safeRef = (value) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value) && !value.includes("..");
if (!safeRef(branch) || !safeRef(baseRef) || !targetInput || isAbsolute(targetInput)) {
  throw new Error("branch, baseRef, and a relative target are required");
}

const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2000 });
if (top.status !== 0) throw new Error("workspace is not a git repository");
const repository = top.stdout.trim();
const targetRoot = dirname(repository);
const target = resolve(targetRoot, targetInput);
const rel = relative(targetRoot, target);
if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("target must stay beside the repository");

const command = ["worktree", "add", "-b", branch, target, baseRef];
if (context.apply !== true) {
  process.stdout.write(JSON.stringify({ status: "preview", repository, target, command: ["git", ...command] }));
  process.exit(0);
}
const created = spawnSync("git", command, { encoding: "utf8", timeout: 8000 });
if (created.status !== 0) throw new Error(created.stderr.trim().slice(0, 500) || "git worktree add failed");
process.stdout.write(JSON.stringify({ status: "created", target, branch, baseRef }));
