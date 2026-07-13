import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [name, version, tarball] = process.argv.slice(2);
if (!name || !version || !tarball) {
  throw new Error("usage: verify-npm-artifact.mjs <package> <version> <local.tgz>");
}
let expected;
let lastError;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    expected = execFileSync("npm", ["view", `${name}@${version}`, "dist.integrity"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    break;
  } catch (error) {
    lastError = error;
    if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
if (!expected) throw lastError ?? new Error(`${name}@${version} is not visible on npm`);
const actual = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
if (actual !== expected) throw new Error(`${name}@${version} exists on npm with different package bytes`);
console.log(`${name}@${version} matches ${tarball}`);
