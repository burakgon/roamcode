import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const context = input ? JSON.parse(input) : {};
const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const repository = git("rev-parse", "--show-toplevel");
if (!repository) throw new Error("workspace is not a git repository");
const workflowDir = join(repository, ".github", "workflows");
const workflowCount = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name)).length
  : 0;
const status = git("status", "--porcelain=v1") ?? "";
const tag = context.includeTags === false ? undefined : git("describe", "--tags", "--abbrev=0");
process.stdout.write(
  JSON.stringify({
    repository: repository.split(/[\\/]/).at(-1),
    branch: git("branch", "--show-current") ?? "detached",
    head: git("rev-parse", "--short=12", "HEAD"),
    clean: status.length === 0,
    changedFiles: status ? status.split("\n").length : 0,
    workflowCount,
    ...(tag ? { latestTag: tag } : {}),
  }),
);
