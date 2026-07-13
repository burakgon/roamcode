import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("usage: pnpm release:prepare <major.minor.patch> (stable SemVer only)");
}

const manifests = [
  "package.json",
  "packages/cli/package.json",
  "packages/server/package.json",
  "packages/web/package.json",
];
for (const name of manifests) {
  const path = resolve(name);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

execFileSync("pnpm", ["install", "--lockfile-only"], { stdio: "inherit" });
console.log(`Prepared v${version}. Add release notes under CHANGELOG.md [Unreleased], then open the release PR.`);
