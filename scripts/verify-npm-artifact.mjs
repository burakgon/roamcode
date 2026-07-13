import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [name, version, tarball] = process.argv.slice(2);
if (!name || !version || !tarball) {
  throw new Error("usage: verify-npm-artifact.mjs <package> <version> <local.tgz>");
}
const expected = execFileSync("npm", ["view", `${name}@${version}`, "dist.integrity"], { encoding: "utf8" }).trim();
const actual = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
if (actual !== expected) throw new Error(`${name}@${version} exists on npm with different package bytes`);
console.log(`${name}@${version} matches ${tarball}`);
